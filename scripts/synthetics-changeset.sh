#!/usr/bin/env bash
# Proves the Synthetics canary is deployable without deploying it.
#
# The canary itself cannot be created on this account: its underlying Lambda
# needs at least 960 MB and the account is capped at 512 MB. So instead of
# executing a deployment, this flips EnableSyntheticsCanary on, asks
# CloudFormation what it *would* create, prints the answer and throws the
# change set away. Nothing in the live stack moves.
#
#   ./synthetics-changeset.sh
set -euo pipefail

export AWS_DEFAULT_REGION=${AWS_DEFAULT_REGION:-us-east-2}
STACK=${STACK:-zuoye-collector}
CHANGE_SET=${CHANGE_SET:-synthetics-evidence}
BACKEND=$(cd "$(dirname "${BASH_SOURCE[0]}")/../backend" && pwd)
WORK=$(mktemp -d)

# Install the cleanup before anything remote exists, so a crash between
# creating the change set and reading it doesn't leave one behind.
cleanup() {
  aws cloudformation delete-change-set --stack-name "${STACK}" \
    --change-set-name "${CHANGE_SET}" >/dev/null 2>&1 || true
  rm -rf "${WORK}"
}
trap cleanup EXIT INT TERM

echo "构建并打包 ${BACKEND} ..."
(cd "${BACKEND}" && npm run --silent build >/dev/null)
(cd "${BACKEND}" && sam package --resolve-s3 \
  --output-template-file "${WORK}/packaged.yaml" >/dev/null)

# Every other parameter keeps its deployed value; only the switch changes.
aws cloudformation describe-stacks --stack-name "${STACK}" \
  --query 'Stacks[0].Parameters[].ParameterKey' --output json |
  python3 -c "
import json, sys
keys = json.load(sys.stdin)
print(json.dumps([
    {'ParameterKey': k, 'ParameterValue': 'true'}
    if k == 'EnableSyntheticsCanary'
    else {'ParameterKey': k, 'UsePreviousValue': True}
    for k in keys
]))
" > "${WORK}/params.json"

# An old change set from an interrupted run would make create fail.
aws cloudformation delete-change-set --stack-name "${STACK}" \
  --change-set-name "${CHANGE_SET}" >/dev/null 2>&1 || true

echo "生成 changeset（EnableSyntheticsCanary=true，不执行）..."
aws cloudformation create-change-set --stack-name "${STACK}" \
  --change-set-name "${CHANGE_SET}" --change-set-type UPDATE \
  --template-body "file://${WORK}/packaged.yaml" \
  --capabilities CAPABILITY_IAM CAPABILITY_AUTO_EXPAND \
  --parameters "file://${WORK}/params.json" \
  --query 'Id' --output text

aws cloudformation wait change-set-create-complete \
  --stack-name "${STACK}" --change-set-name "${CHANGE_SET}"

echo
echo "巡检相关资源（CloudFormation 确认会创建）:"
aws cloudformation describe-change-set --stack-name "${STACK}" \
  --change-set-name "${CHANGE_SET}" \
  --query "Changes[?contains(ResourceChange.ResourceType, 'Synthetics') ||
           starts_with(ResourceChange.LogicalResourceId, 'Synthetics')].ResourceChange.[Action,ResourceType,LogicalResourceId]" \
  --output text

echo
echo "未执行——执行会因 960MB 内存下限失败。changeset 已在退出时删除。"
