#!/usr/bin/env bash
# Walks through the AIOps agent end to end, live.
#
#   ./scripts/aiops-demo.sh              # 只读演示，约 2 分钟
#   ./scripts/aiops-demo.sh --inject     # 先注入一条毒丸消息制造真故障
#
# 只读演示不改动任何线上状态；写操作一律停在演练，需要人确认才会真执行。
# Needs the AWS CLI configured for us-east-2.
set -uo pipefail

export AWS_DEFAULT_REGION=us-east-2
STACK=${STACK:-zuoye-collector}
AIOPS_STACK=${AIOPS_STACK:-zuoye-aiops}
MCP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../aiops-mcp" && pwd)"

blue() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

out() {
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
}

DLQ=$(out "$STACK" DeadLetterQueueUrl)
TOPIC=$(out "$STACK" AlertsTopicArn)
FN=$(out "$AIOPS_STACK" DiagnosisFunctionName)
LOG_GROUP=$(out "$AIOPS_STACK" DiagnosisLogGroupName)

echo "被诊断的栈: $STACK"
echo "诊断函数:   $FN"

# ---------------------------------------------------------------------------
if [ "${1:-}" = "--inject" ]; then
  blue "0 · 注入故障：往死信队列投一条格式非法的消息"
  aws sqs send-message --queue-url "$DLQ" \
    --message-body "not-a-json-event-$(date +%s)" >/dev/null
  ok "已投递。它永远无法被 worker 解析，正是死信队列该装的东西"
  info "DLQ 告警通常在 5 分钟内进入 ALARM"
fi

# ---------------------------------------------------------------------------
blue "1 · 现状：Agent 能看到什么"

VISIBLE=$(aws sqs get-queue-attributes --queue-url "$DLQ" \
  --attribute-names ApproximateNumberOfMessages \
  --query 'Attributes.ApproximateNumberOfMessages' --output text)
info "死信队列可见消息数: ${VISIBLE}"

FIRING=$(aws cloudwatch describe-alarms --state-value ALARM \
  --query 'MetricAlarms[?starts_with(AlarmName, `zuoye`)].AlarmName' --output text)
if [ -n "$FIRING" ]; then
  warn "正在触发的告警: ${FIRING}"
else
  ok "当前没有告警在触发"
fi

# ---------------------------------------------------------------------------
blue "2 · 无人值守：告警自动触发一轮诊断"

SINCE=$(($(date -u +%s) * 1000))
MARKER="demo-$(date +%s)"

aws sns publish --topic-arn "$TOPIC" \
  --subject "ALARM: aiops demo" \
  --message "{\"AlarmName\":\"${FIRING:-zuoye-collector-DeadLetterQueueAlarm}\",\"NewStateValue\":\"ALARM\",\"OldStateValue\":\"OK\",\"NewStateReason\":\"${MARKER}\",\"StateChangeTime\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000+0000)\",\"Region\":\"US East (Ohio)\"}" \
  >/dev/null
info "已向告警主题发布一条 ALARM 通知，等待诊断函数被触发..."

FOUND=""
for _ in $(seq 1 12); do
  sleep 5
  FOUND=$(aws logs filter-log-events --log-group-name "$LOG_GROUP" \
    --start-time "$SINCE" --filter-pattern '"aiops_incident"' \
    --query 'events[-1].message' --output text 2>/dev/null)
  [ -n "$FOUND" ] && [ "$FOUND" != "None" ] && break
done

if [ -n "$FOUND" ] && [ "$FOUND" != "None" ]; then
  ok "诊断函数已被 SNS 触发并写下 incident 记录"
  # 日志行前面有 Lambda 加的时间戳与请求 ID，从第一个 { 开始才是 JSON。
  # 这也是为什么检索只能用子串匹配，不能把 marker 当顶层字段来查。
  echo "$FOUND" | sed 's/^[^{]*//' | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("    指纹        " + d["fingerprint"])
print("    当前健康    " + str(d["healthyNow"]))
print("    可能根因    " + (" / ".join(d["likelyCauses"]) or "无"))
print("    建议动作    " + (" / ".join(d["suggestedActions"]) or "无"))
print("    关联发现:")
for c in d["correlations"]:
    print("      - " + c)
' || info "$FOUND"
else
  warn "12 次轮询内没等到 incident 记录，检查 ${LOG_GROUP}"
fi

DELIVERY=$(aws logs filter-log-events --log-group-name "$LOG_GROUP" \
  --start-time "$SINCE" --filter-pattern '"aiops_delivery"' \
  --query 'events[-1].message' --output text 2>/dev/null)
if [ -n "$DELIVERY" ] && [ "$DELIVERY" != "None" ]; then
  case "$DELIVERY" in
    *未配置*) info "飞书通知与工单未配置，已优雅跳过（配上环境变量即生效）" ;;
    *) ok "通知与工单已投递" ;;
  esac
fi

# ---------------------------------------------------------------------------
blue "3 · 人在环：Agent 侧跑同一轮诊断"

if [ -d "$MCP_DIR/node_modules" ]; then
  (cd "$MCP_DIR" && npx tsx scripts/diagnose-once.ts 120)
  ok "同一套工具，云端无人值守跑一遍，本地 Agent 也能跑一遍"
else
  info "跳过——先在 aiops-mcp 目录执行 npm install"
fi

# ---------------------------------------------------------------------------
blue "4 · 处置：写操作停在演练，不改任何东西"

if [ -d "$MCP_DIR/node_modules" ]; then
  (cd "$MCP_DIR" && npx tsx scripts/dry-run.ts)
  ok "两个写工具都停在演练，没有投递、没有删除"
  info "真要处置：在 Agent 里让它带 dryRun=false 调用，届时会先存还原点"
else
  info "跳过——先在 aiops-mcp 目录执行 npm install"
fi

blue "完成"
info "incident 记录查询: aws logs filter-log-events --log-group-name ${LOG_GROUP} --filter-pattern '\"aiops_incident\"'"
