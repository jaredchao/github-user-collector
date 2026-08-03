#!/usr/bin/env bash
# Deploys the AIOps diagnosis stack, reading secrets from a gitignored file.
#
#   cp aiops-mcp/deploy.env.example aiops-mcp/deploy.env   # 填好凭证
#   ./scripts/aiops-deploy.sh
#
# 凭证只经 SAM 参数传给 CloudFormation，不落进命令历史、不进版本库。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MCP_DIR="$ROOT/aiops-mcp"
ENV_FILE="$MCP_DIR/deploy.env"

blue() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

if [ ! -f "$ENV_FILE" ]; then
  echo "缺少 $ENV_FILE"
  echo "先执行: cp aiops-mcp/deploy.env.example aiops-mcp/deploy.env 并填写"
  exit 1
fi

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

export AWS_DEFAULT_REGION=${AWS_REGION:-us-east-2}
STACK=${COLLECTOR_STACK:-zuoye-collector}

blue "1 · 构建 Lambda 产物"
BUILD_LOG=$(cd "$MCP_DIR" && npm run build:lambda 2>&1) || {
  echo "$BUILD_LOG"
  exit 1
}
ok "dist/aiops.mjs 已生成（$(du -h "$MCP_DIR/dist/aiops.mjs" | cut -f1 | tr -d ' ')）"

blue "2 · 读取被诊断栈的告警主题"
TOPIC=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`AlertsTopicArn`].OutputValue' --output text)
[ -n "$TOPIC" ] || { echo "找不到 $STACK 的 AlertsTopicArn"; exit 1; }
ok "已定位告警主题"

blue "3 · 配置自检"
[ -n "${FEISHU_WEBHOOK:-}" ] && ok "飞书通知：已配置" || warn "飞书通知：未配置，将跳过"
if [ -n "${FEISHU_APP_ID:-}" ] && [ -n "${FEISHU_APP_SECRET:-}" ] \
   && [ -n "${BASE_APP_TOKEN:-}" ] && [ -n "${BASE_TABLE_ID:-}" ]; then
  ok "多维表格工单：已配置"
else
  warn "多维表格工单：未配置齐全，将跳过"
fi
if [ -n "${REMOTE_MCP_TOKEN:-}" ]; then
  # 短令牌等于没有保护——这个端点是公开在互联网上的
  if [ "${#REMOTE_MCP_TOKEN}" -lt 32 ]; then
    echo "REMOTE_MCP_TOKEN 太短（${#REMOTE_MCP_TOKEN} 字符），公网端点至少要 32 位随机值"
    echo "生成一个: openssl rand -hex 32"
    exit 1
  fi
  ok "远程只读 MCP：已配置（令牌 ${#REMOTE_MCP_TOKEN} 字符）"
else
  warn "远程只读 MCP：未配置，不创建该端点"
fi

blue "4 · 部署"

# SAM 不接受空值参数（FeishuWebhook= 会被判为格式非法），空的一律不传，
# 让模板里的 Default: "" 生效
PARAMS=(
  "CollectorStackName=$STACK"
  "AlertsTopicArn=$TOPIC"
  "EcsClusterName=${ECS_CLUSTER:-zuoye-cluster}"
  "DiagnosisWindowMinutes=${DIAGNOSIS_WINDOW_MINUTES:-60}"
)
add_param() {
  local value="${2:-}"
  [ -n "$value" ] && PARAMS+=("$1=$value")
  return 0
}
add_param FeishuWebhook "${FEISHU_WEBHOOK:-}"
add_param FeishuSecret "${FEISHU_SECRET:-}"
add_param FeishuAppId "${FEISHU_APP_ID:-}"
add_param FeishuAppSecret "${FEISHU_APP_SECRET:-}"
add_param BaseAppToken "${BASE_APP_TOKEN:-}"
add_param BaseTableId "${BASE_TABLE_ID:-}"
add_param RemoteMcpToken "${REMOTE_MCP_TOKEN:-}"

(cd "$MCP_DIR" && sam deploy \
  --template-file template.yaml \
  --stack-name "${AIOPS_STACK:-zuoye-aiops}" \
  --region "$AWS_DEFAULT_REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides "${PARAMS[@]}" \
  | tail -20)

blue "完成"
echo "  验证: ./scripts/aiops-demo.sh"
