#!/usr/bin/env bash
# Create (or refresh) the per-PR environment for the Go service.
# Expects PR_NUMBER in the environment and AWS credentials already configured.
# Idempotent: safe to rerun on every PR synchronize event.
set -euo pipefail

: "${PR_NUMBER:?PR_NUMBER is required}"
export AWS_DEFAULT_REGION=us-east-2

ACCOUNT_ID=089783390738
CLUSTER=zuoye-cluster
VPC_ID=vpc-0500d1d04f4e52277
PRIVATE_SUBNETS=subnet-0002fe719ea8b06de,subnet-06955f494d0031dee
SERVICE_SG=sg-09113e3223b77e76d
NAMESPACE_ID=ns-5fkzrmwi3bzbrcx3
HTTPS_LISTENER_ARN=arn:aws:elasticloadbalancing:us-east-2:089783390738:listener/app/zuoye-alb/b7eef5ad5de97ea9/1638c002625ab6cf
BASE_TASK_FAMILY=zuoye-go-service
IMAGE=$ACCOUNT_ID.dkr.ecr.us-east-2.amazonaws.com/zuoye-go-service:pr-$PR_NUMBER

TG_NAME=zuoye-pr-$PR_NUMBER-tg
HOST=pr-$PR_NUMBER.go-api.jccode.cc
CLOUDMAP_NAME=go-service-pr-$PR_NUMBER
PR_FAMILY=zuoye-go-service-pr-$PR_NUMBER
SERVICE_NAME=zuoye-go-service-pr-$PR_NUMBER

# --- 1. Target group -------------------------------------------------------
TG_ARN=$(aws elbv2 describe-target-groups --names "$TG_NAME" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group \
    --name "$TG_NAME" --protocol HTTP --port 8080 --vpc-id "$VPC_ID" \
    --target-type ip --health-check-path /health \
    --health-check-interval-seconds 10 \
    --healthy-threshold-count 2 --unhealthy-threshold-count 2 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  # PR envs are throwaway; don't hold deregistering targets for 5 minutes.
  aws elbv2 modify-target-group-attributes --target-group-arn "$TG_ARN" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=10 >/dev/null
fi
echo "target group: $TG_ARN"

# --- 2. ALB host-header rule ----------------------------------------------
RULE_ARN=$(aws elbv2 describe-rules --listener-arn "$HTTPS_LISTENER_ARN" \
  --query "Rules[?Conditions[?Field=='host-header' && contains(Values, '$HOST')]].RuleArn" \
  --output text)
if [ -z "$RULE_ARN" ]; then
  RULE_ARN=$(aws elbv2 create-rule --listener-arn "$HTTPS_LISTENER_ARN" \
    --priority "$PR_NUMBER" \
    --conditions "Field=host-header,Values=$HOST" \
    --actions "Type=forward,TargetGroupArn=$TG_ARN" \
    --query 'Rules[0].RuleArn' --output text)
fi
echo "listener rule: $RULE_ARN"

# --- 3. CloudMap service ----------------------------------------------------
REGISTRY_ARN=$(aws servicediscovery list-services \
  --filters "Name=NAMESPACE_ID,Values=$NAMESPACE_ID" \
  --query "Services[?Name=='$CLOUDMAP_NAME'].Arn" --output text)
if [ -z "$REGISTRY_ARN" ]; then
  REGISTRY_ARN=$(aws servicediscovery create-service \
    --name "$CLOUDMAP_NAME" --namespace-id "$NAMESPACE_ID" \
    --dns-config "RoutingPolicy=MULTIVALUE,DnsRecords=[{Type=A,TTL=10}]" \
    --query 'Service.Arn' --output text)
fi
echo "cloudmap: $REGISTRY_ARN ($CLOUDMAP_NAME.zuoye.internal)"

# --- 4. Task definition -----------------------------------------------------
# Clone the production task definition so DATABASE_URL and friends stay in
# AWS and never pass through GitHub. Only family and image change.
aws ecs describe-task-definition --task-definition "$BASE_TASK_FAMILY" \
  --query 'taskDefinition' --output json \
  | jq --arg family "$PR_FAMILY" --arg image "$IMAGE" '
      del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
          .compatibilities, .registeredAt, .registeredBy)
      | .family = $family
      | .containerDefinitions[0].image = $image' \
  > /tmp/pr-taskdef.json
TASKDEF_ARN=$(aws ecs register-task-definition \
  --cli-input-json file:///tmp/pr-taskdef.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "task definition: $TASKDEF_ARN"

# --- 5. ECS service ---------------------------------------------------------
STATUS=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE_NAME" \
  --query 'services[0].status' --output text 2>/dev/null || true)
if [ "$STATUS" = "ACTIVE" ]; then
  # Same pr-N image tag was re-pushed; a forced deployment picks it up.
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE_NAME" \
    --task-definition "$TASKDEF_ARN" --force-new-deployment >/dev/null
  echo "service updated: $SERVICE_NAME"
else
  aws ecs create-service --cluster "$CLUSTER" --service-name "$SERVICE_NAME" \
    --task-definition "$TASKDEF_ARN" --desired-count 1 --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$PRIVATE_SUBNETS],securityGroups=[$SERVICE_SG],assignPublicIp=DISABLED}" \
    --load-balancers "targetGroupArn=$TG_ARN,containerName=go-service,containerPort=8080" \
    --service-registries "registryArn=$REGISTRY_ARN" \
    --health-check-grace-period-seconds 30 >/dev/null
  echo "service created: $SERVICE_NAME"
fi

echo "waiting for the service to stabilize..."
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE_NAME"
echo "PR environment ready: https://$HOST"
