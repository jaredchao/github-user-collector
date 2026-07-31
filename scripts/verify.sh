#!/usr/bin/env bash
# Walks through what the three homework-3 features actually do, live.
#
#   ./scripts/verify.sh            # everything except the 15-minute DLQ demo
#   ./scripts/verify.sh --dlq      # also send poison messages and wait for the DLQ
#
# Needs the AWS CLI configured for us-east-2.
set -uo pipefail

export AWS_DEFAULT_REGION=us-east-2
STACK=${STACK:-zuoye-collector}
PROBE_USER=${PROBE_USER:-octocat}

blue() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }

API=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
FUNCTION=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionName`].OutputValue' --output text)
QUEUE=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`IntroductionQueueUrl`].OutputValue' --output text)
DLQ=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`DeadLetterQueueUrl`].OutputValue' --output text)

echo "API:      $API"
echo "前端:     https://zuoye-frontend.pages.dev"

blue "任务 2 · 异步链路：保存是同步的，生成介绍是异步的"

# A user that has never been collected has no introduction to read yet, which
# is the whole point: the endpoint reads stored text rather than rendering it.
BEFORE=$(curl -s -o /dev/null -w '%{http_code}' "$API/users/${PROBE_USER}/intro")
info "采集前 GET /users/${PROBE_USER}/intro → ${BEFORE}（404 说明读的是持久化值，不是实时拼接）"

START=$(date +%s)
SAVE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$API/users" \
  -H 'Content-Type: application/json' -d "{\"username\":\"${PROBE_USER}\"}")
[ "$SAVE" = "201" ] && ok "POST /users → 201，Profile 已同步保存（主请求不等介绍）" \
                    || info "POST /users → ${SAVE}"

for i in $(seq 1 20); do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "$API/users/${PROBE_USER}/intro")
  if [ "$CODE" = "200" ]; then
    ok "介绍在 T+$(( $(date +%s) - START ))s 出现（SNS → SQS → Worker → Go → RDS 全程）"
    curl -s "$API/users/${PROBE_USER}/intro" | head -c 200
    echo
    break
  fi
  info "T+$(( $(date +%s) - START ))s 介绍尚未生成（${CODE}），继续等"
  sleep 2
done

blue "  Worker 日志（异步这一段真的跑了）"
WORKER=$(aws lambda list-functions \
  --query "Functions[?contains(FunctionName,'IntroductionWorker')].FunctionName|[0]" --output text)
# CloudWatch takes a few seconds to index a fresh log line, so retry rather
# than reporting "no evidence" for a worker that in fact just ran.
for attempt in 1 2 3 4 5 6; do
  LOGS=$(aws logs filter-log-events --log-group-name "/aws/lambda/${WORKER}" \
    --start-time $(( ($(date +%s) - 900) * 1000 )) --filter-pattern "generated" \
    --query 'events[-2:].message' --output text 2>/dev/null)
  [ -n "$LOGS" ] && break
  sleep 5
done
if [ -n "$LOGS" ]; then
  echo "$LOGS" | sed 's/^/    /'
else
  info "(日志尚未索引，稍后可重跑)"
fi

blue "  队列与死信队列"
for NAME in "主队列:${QUEUE}" "死信队列:${DLQ}"; do
  LABEL=${NAME%%:*}; URL=${NAME#*:}
  N=$(aws sqs get-queue-attributes --queue-url "$URL" \
    --attribute-names ApproximateNumberOfMessages \
    --query 'Attributes.ApproximateNumberOfMessages' --output text)
  info "${LABEL} 当前积压: ${N}"
done
REDRIVE=$(aws sqs get-queue-attributes --queue-url "$QUEUE" --attribute-names RedrivePolicy \
  --query 'Attributes.RedrivePolicy' --output text)
info "重试策略: ${REDRIVE}"

blue "任务 3 · 灰度发布：流量走别名，不是 \$LATEST"

ALIAS=$(aws lambda get-alias --function-name "$FUNCTION" --name live \
  --query '{v:FunctionVersion,r:RoutingConfig}' --output json)
info "live 别名: ${ALIAS}"
API_ID=$(aws cloudformation describe-stack-resources --stack-name "$STACK" \
  --query "StackResources[?ResourceType=='AWS::ApiGatewayV2::Api'].PhysicalResourceId" --output text)
INTEGRATION=$(aws apigatewayv2 get-integrations --api-id "$API_ID" \
  --query 'Items[0].IntegrationUri' --output text)
case "$INTEGRATION" in
  *:live/invocations) ok "API Gateway 打的是 live 别名（灰度才有意义）" ;;
  *) info "API Gateway 集成: ${INTEGRATION}" ;;
esac

blue "  回滚门禁（灰度期间由这两条告警看守）"
# JMESPath keys must be ASCII, so format the labels here instead.
aws cloudwatch describe-alarms \
  --alarm-names "${STACK}-release-errors" "${STACK}-release-latency" \
  --query 'MetricAlarms[].[AlarmName,StateValue]' --output text \
  | while read -r NAME STATE; do info "${NAME}: ${STATE}"; done

info "想亲手看一次回滚，见 README 的「演示灰度回滚」一节"

blue "任务 1 · 巡检：目标端点与 canary 状态"

READY=$(curl -s -w ' [%{http_code}]' "$API/ready")
ok "GET /ready → ${READY}"
info "一次调用走通 API Gateway → Lambda → Go on ECS → PostgreSQL，且不碰用户数据"

CANARY=$(aws synthetics describe-canaries --query 'Canaries[].Name' --output text 2>/dev/null)
if [ -n "$CANARY" ]; then
  ok "Synthetics canary 已创建: ${CANARY}"
  aws synthetics get-canary --name "$CANARY" \
    --query 'Canary.[Status.State,Schedule.Expression,RuntimeVersion]' --output text \
    | while read -r STATE SCHED RT; do info "状态 ${STATE} / 计划 ${SCHED} / 运行时 ${RT}"; done
else
  info "Synthetics canary 尚未创建（模板已就绪，开关默认关闭）"
  QUOTA=$(aws service-quotas list-requested-service-quota-change-history --service-code lambda \
    --query 'RequestedQuotas[0].{s:Status,c:CaseId}' --output text 2>/dev/null)
  info "原因: canary 底层 Lambda 需 960MB，本账号上限 512MB。配额工单: ${QUOTA}"
  info "批准后执行: sam deploy ... --parameter-overrides EnableSyntheticsCanary=true"
fi

if [ "${1:-}" = "--dlq" ]; then
  blue "死信队列演示：毒消息重试 5 次后进 DLQ（约 15 分钟）"
  aws sqs send-message --queue-url "$QUEUE" --message-body 'not-a-json-event' \
    --query 'MessageId' --output text | sed 's/^/    已投递毒消息 /'
  for i in $(seq 1 40); do
    N=$(aws sqs get-queue-attributes --queue-url "$DLQ" \
      --attribute-names ApproximateNumberOfMessages \
      --query 'Attributes.ApproximateNumberOfMessages' --output text)
    info "[${i}] DLQ 深度: ${N}"
    if [ "$N" != "0" ]; then
      ok "毒消息已进入死信队列"
      aws sqs receive-message --queue-url "$DLQ" --visibility-timeout 0 \
        --attribute-names ApproximateReceiveCount \
        --query 'Messages[0].[Body,Attributes.ApproximateReceiveCount]' --output text \
        | while read -r BODY COUNT; do info "消息内容: ${BODY}（被接收 ${COUNT} 次后转入）"; done
      info "清空 DLQ: aws sqs purge-queue --queue-url ${DLQ}"
      break
    fi
    sleep 30
  done
fi

blue "验证结束"
