#!/usr/bin/env bash
# Progressive release for the collector Lambda, driven by the `live` alias's
# own weighted routing.
#
# This is what CodeDeploy's Canary10Percent5Minutes does, written out by hand
# because this account has no CodeDeploy subscription: point the alias at the
# known-good version, send a slice of traffic to the candidate, watch the
# release alarms for a bake period, then either promote or roll back.
#
#   ./canary-release.sh              # promote the newest published version
#   ./canary-release.sh 7            # promote version 7 specifically
#   PERCENT=25 BAKE=120 ./canary-release.sh
set -euo pipefail

export AWS_DEFAULT_REGION=us-east-2
STACK=${STACK:-zuoye-collector}
ALIAS=live
PERCENT=${PERCENT:-10}
BAKE=${BAKE:-300}
POLL=${POLL:-15}

FUNCTION=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionName`].OutputValue' --output text)
ALARMS=("${STACK}-release-errors" "${STACK}-release-latency")

STABLE=$(aws lambda get-alias --function-name "$FUNCTION" --name "$ALIAS" \
  --query 'FunctionVersion' --output text)
TARGET=${1:-$(aws lambda list-versions-by-function --function-name "$FUNCTION" \
  --query 'Versions[-1].Version' --output text)}

echo "函数:   $FUNCTION"
echo "稳定版: $STABLE    候选版: $TARGET"

if [ "$STABLE" = "$TARGET" ]; then
  echo "别名已经指向 $TARGET，无需发布。"
  exit 0
fi

rollback() {
  aws lambda update-alias --function-name "$FUNCTION" --name "$ALIAS" \
    --function-version "$STABLE" \
    --routing-config '{"AdditionalVersionWeights":{}}' >/dev/null
  echo "已回滚：100% 流量回到 $STABLE"
}

# The alias keeps pointing at the stable version; the candidate only gets the
# extra weight. That way a rollback is one API call and never has a moment
# where the bad version serves everything.
aws lambda update-alias --function-name "$FUNCTION" --name "$ALIAS" \
  --function-version "$STABLE" \
  --routing-config "{\"AdditionalVersionWeights\":{\"$TARGET\":$(awk "BEGIN{print $PERCENT/100}")}}" \
  >/dev/null
echo "灰度中：${PERCENT}% → $TARGET，其余留在 $STABLE。观察 ${BAKE}s"

# Alarms that were already firing before the release would roll back a
# perfectly good version, so wait for them to clear first.
for A in "${ALARMS[@]}"; do
  STATE=$(aws cloudwatch describe-alarms --alarm-names "$A" \
    --query 'MetricAlarms[0].StateValue' --output text 2>/dev/null || echo "MISSING")
  if [ "$STATE" = "ALARM" ]; then
    echo "告警 $A 在发布前就是 ALARM，先修好再发布。"
    rollback
    exit 1
  fi
done

deadline=$((SECONDS + BAKE))
while [ $SECONDS -lt $deadline ]; do
  for A in "${ALARMS[@]}"; do
    STATE=$(aws cloudwatch describe-alarms --alarm-names "$A" \
      --query 'MetricAlarms[0].StateValue' --output text 2>/dev/null || echo "MISSING")
    if [ "$STATE" = "ALARM" ]; then
      echo "$(date +%T) 告警 $A 触发 → 回滚"
      rollback
      exit 1
    fi
  done
  echo "  $(date +%T) 告警正常，剩余 $((deadline - SECONDS))s"
  sleep "$POLL"
done

aws lambda update-alias --function-name "$FUNCTION" --name "$ALIAS" \
  --function-version "$TARGET" \
  --routing-config '{"AdditionalVersionWeights":{}}' >/dev/null
echo "观察期无告警：100% 流量已切到 $TARGET"
