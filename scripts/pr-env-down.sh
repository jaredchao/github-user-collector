#!/usr/bin/env bash
# Tear down the per-PR environment created by pr-env-up.sh.
# Every step tolerates the resource already being gone, so a half-created
# environment (or a rerun) cleans up without errors.
set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER is required}"
export AWS_DEFAULT_REGION=us-east-2

CLUSTER=zuoye-cluster
NAMESPACE_ID=ns-5fkzrmwi3bzbrcx3
HTTPS_LISTENER_ARN=arn:aws:elasticloadbalancing:us-east-2:089783390738:listener/app/zuoye-alb/b7eef5ad5de97ea9/1638c002625ab6cf
SOURCE_BUCKET=zuoye-codebuild-source-089783390738

TG_NAME=zuoye-pr-$PR_NUMBER-tg
HOST=pr-$PR_NUMBER.go-api.jccode.cc
CLOUDMAP_NAME=go-service-pr-$PR_NUMBER
PR_FAMILY=zuoye-go-service-pr-$PR_NUMBER
SERVICE_NAME=zuoye-go-service-pr-$PR_NUMBER

# --- 1. ALB rule (stop routing traffic first) -------------------------------
RULE_ARN=$(aws elbv2 describe-rules --listener-arn "$HTTPS_LISTENER_ARN" \
  --query "Rules[?Conditions[?Field=='host-header' && contains(Values, '$HOST')]].RuleArn" \
  --output text)
if [ -n "$RULE_ARN" ]; then
  aws elbv2 delete-rule --rule-arn "$RULE_ARN"
  echo "deleted listener rule"
fi

# --- 2. ECS service ----------------------------------------------------------
STATUS=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" \
  --query 'services[0].status' --output text 2>/dev/null || true)
if [ "$STATUS" = "ACTIVE" ] || [ "$STATUS" = "DRAINING" ]; then
  aws ecs delete-service --cluster "$CLUSTER" --service "$SERVICE_NAME" --force >/dev/null
  echo "deleting service, waiting until inactive..."
  aws ecs wait services-inactive --cluster "$CLUSTER" --services "$SERVICE_NAME"
fi

# --- 3. Task definition revisions --------------------------------------------
for ARN in $(aws ecs list-task-definitions --family-prefix "$PR_FAMILY" \
    --query 'taskDefinitionArns[]' --output text); do
  aws ecs deregister-task-definition --task-definition "$ARN" >/dev/null
  echo "deregistered $ARN"
done

# --- 4. CloudMap service ------------------------------------------------------
# ECS deregisters instances while the service drains; retry briefly in case
# the last instance is still detaching.
SD_ID=$(aws servicediscovery list-services \
  --filters "Name=NAMESPACE_ID,Values=$NAMESPACE_ID" \
  --query "Services[?Name=='$CLOUDMAP_NAME'].Id" --output text)
if [ -n "$SD_ID" ]; then
  for i in $(seq 1 12); do
    if aws servicediscovery delete-service --id "$SD_ID" 2>/dev/null; then
      echo "deleted cloudmap service"
      break
    fi
    echo "cloudmap service still has instances, retrying ($i/12)..."
    sleep 10
  done
fi

# --- 5. Target group ----------------------------------------------------------
TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
  aws elbv2 delete-target-group --target-group-arn "$TG_ARN"
  echo "deleted target group"
fi

# --- 6. ECR image + build source (stop storage charges) ------------------------
aws ecr batch-delete-image --repository-name zuoye-go-service \
  --image-ids imageTag=pr-$PR_NUMBER >/dev/null && echo "deleted image tag pr-$PR_NUMBER"
aws s3 rm "s3://$SOURCE_BUCKET/pr-$PR_NUMBER/" --recursive

echo "PR $PR_NUMBER environment fully removed"
