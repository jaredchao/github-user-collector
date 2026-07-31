#!/usr/bin/env bash
# Drives traffic at the API while a canary deployment is in flight.
#
# A canary release only protects you if the canary window sees traffic: with
# zero requests, 10% of nothing is nothing, no alarm can fire, and a broken
# version rolls out to 100% looking perfectly healthy. This script supplies
# that traffic and reports how the deployment ended.
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-2
STACK=${STACK:-zuoye-collector}
DURATION=${DURATION:-480}
INTERVAL=${INTERVAL:-1}

API=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
APP=$(aws deploy list-applications --query "applications[?contains(@, 'zuoye-collector')]|[0]" --output text)
GROUP=$(aws deploy list-deployment-groups --application-name "$APP" \
  --query 'deploymentGroups[0]' --output text)

echo "API:   $API"
echo "组:    $APP / $GROUP"
echo "打流量 ${DURATION}s，每 ${INTERVAL}s 一次..."

ok=0
fail=0
deadline=$((SECONDS + DURATION))
while [ $SECONDS -lt $deadline ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API/health" || echo "000")
  if [ "$code" = "200" ]; then
    ok=$((ok + 1))
  else
    fail=$((fail + 1))
    echo "  $(date +%T) 命中坏版本: HTTP $code"
  fi

  DEPLOY=$(aws deploy list-deployments --application-name "$APP" --deployment-group-name "$GROUP" \
    --query 'deployments[0]' --output text 2>/dev/null || echo "None")
  if [ "$DEPLOY" != "None" ] && [ -n "$DEPLOY" ]; then
    STATUS=$(aws deploy get-deployment --deployment-id "$DEPLOY" \
      --query 'deploymentInfo.status' --output text)
    case "$STATUS" in
      Succeeded|Failed|Stopped)
        echo "部署 $DEPLOY 结束: $STATUS"
        aws deploy get-deployment --deployment-id "$DEPLOY" \
          --query 'deploymentInfo.{status:status,rollback:rollbackInfo,error:errorInformation}' --output json
        break
        ;;
    esac
  fi
  sleep "$INTERVAL"
done

echo "成功 $ok 次，失败 $fail 次"
