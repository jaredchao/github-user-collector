#!/usr/bin/env bash
# Deploys the whole performance monitoring chain:
#
#   perf-sdk      构建产物（供页面引入）
#   perf-ingest   API Gateway + Lambda -> CloudWatch Logs
#   perf-cleaner  ECS Fargate 清洗服务 + ALB 路由
#   perf-dashboard 构建产物（部署到 Cloudflare Pages）
#
#   cp perf-cleaner/deploy.env.example perf-cleaner/deploy.env   # 填 DATABASE_URL
#   ./scripts/perf-deploy.sh
#
# 幂等：重复执行只做增量更新。网络设施（子网、安全组、ALB）不写死，
# 一律从现有 Go 服务上读，避免两处配置漂移。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/perf-cleaner/deploy.env"

blue() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

# CI passes the same settings as environment variables and has no env file.
# Keeping one script for both means a deployment cannot drift from what the
# pipeline does.
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
elif [ -z "${DATABASE_URL:-}" ]; then
  echo "缺少 ${ENV_FILE}，且环境里也没有 DATABASE_URL"
  echo "先执行: cp perf-cleaner/deploy.env.example perf-cleaner/deploy.env 并填写"
  exit 1
fi

: "${DATABASE_URL:?必须提供 DATABASE_URL}"

export AWS_DEFAULT_REGION=${AWS_REGION:-us-east-2}
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CLUSTER=${ECS_CLUSTER:-zuoye-cluster}
BASE_SERVICE=${BASE_SERVICE:-zuoye-go-service-service}
INGEST_STACK=${INGEST_STACK:-zuoye-perf-ingest}
CLEANER_STACK=${CLEANER_STACK:-zuoye-perf-cleaner}
HOST_NAME=${PERF_HOST:-perf.go-api.jccode.cc}
REPO=${ECR_REPO:-zuoye-perf-cleaner}
IMAGE_TAG=${IMAGE_TAG:-latest}
IMAGE_URI="$ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com/$REPO:$IMAGE_TAG"

blue "1 · 读取现有网络配置"
# The cleaner has to sit in the same subnets and security group as the Go
# service, or it cannot reach RDS. Reading them beats copying them.
NETWORK=$(aws ecs describe-services --cluster "$CLUSTER" --services "$BASE_SERVICE" \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json)
SUBNETS=$(echo "$NETWORK" | jq -r '.subnets | join(",")')
SECURITY_GROUP=$(echo "$NETWORK" | jq -r '.securityGroups[0]')
[ -n "$SUBNETS" ] && [ "$SUBNETS" != "null" ] || { echo "读不到子网，确认 $BASE_SERVICE 存在"; exit 1; }

VPC_ID=$(aws ec2 describe-subnets --subnet-ids "${SUBNETS%%,*}" \
  --query 'Subnets[0].VpcId' --output text)

LB_ARN=$(aws elbv2 describe-load-balancers --names "${ALB_NAME:-zuoye-alb}" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
LISTENER_ARN=$(aws elbv2 describe-listeners --load-balancer-arn "$LB_ARN" \
  --query 'Listeners[?Port==`443`].ListenerArn | [0]' --output text)
# CloudWatch identifies a load balancer by the tail of its ARN.
LB_FULL_NAME=${LB_ARN#*:loadbalancer/}
ok "子网 $SUBNETS"
ok "安全组 ${SECURITY_GROUP}，VPC ${VPC_ID}"
ok "监听器 ${LISTENER_ARN##*/}"

blue "2 · 部署摄取栈（API Gateway + Lambda + 日志组）"
(cd "$ROOT/perf-ingest" && npm ci --silent && npm run build >/dev/null)
ok "Lambda 产物已构建"

(cd "$ROOT/perf-ingest" && sam deploy \
  --template-file template.yaml \
  --stack-name "$INGEST_STACK" \
  --region "$AWS_DEFAULT_REGION" \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --no-confirm-changeset \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "AllowedOrigins=${SDK_ALLOWED_ORIGINS:-}" \
    "RawLogGroupName=${RAW_LOG_GROUP:-/perf/raw}" \
  | tail -5)

INGEST_URL=$(aws cloudformation describe-stacks --stack-name "$INGEST_STACK" \
  --query 'Stacks[0].Outputs[?OutputKey==`IngestUrl`].OutputValue' --output text)
ok "摄取端点 $INGEST_URL"

blue "3 · 应用数据库迁移"
# Two different connection strings are in play. DATABASE_URL is what the ECS
# task gets: the container sits inside the VPC and reaches RDS directly. But
# RDS is not publicly accessible, so this script — running on a laptop or a
# CI runner — cannot use that same address. Set MIGRATION_DATABASE_URL to a
# tunnelled one (see the hint below) when running the migration from outside.
#
# Deliberately not `npm run migrate`: that loads backend/.env, which on a
# developer machine points at the local Docker database, and the migration
# would silently land there instead of on RDS.
if [ "${SKIP_MIGRATION:-}" = "1" ]; then
  warn "SKIP_MIGRATION=1，跳过迁移（确保 perf_* 表已存在）"
else
  MIGRATE_URL=${MIGRATION_DATABASE_URL:-$DATABASE_URL}
  (cd "$ROOT/backend" && npm ci --silent >/dev/null 2>&1 || true)
  if (cd "$ROOT/backend" && DATABASE_URL="$MIGRATE_URL" npx tsx scripts/migrate.ts >/dev/null 2>&1); then
    ok "perf_* 表已就绪"
  else
    # Stopping here is deliberate: without the tables the cleaner would
    # deploy fine and then fail on every single poll.
    echo
    echo "  迁移失败——大概率是连不上 RDS（它不对公网开放）。"
    echo "  先开一条 SSM 隧道，再用隧道地址重跑："
    echo
    echo "    aws ssm start-session --target ${BASTION_ID:-i-0453f29271df01fd4} \\"
    echo "      --document-name AWS-StartPortForwardingSessionToRemoteHost \\"
    echo "      --parameters '{\"host\":[\"<rds-endpoint>\"],\"portNumber\":[\"5432\"],\"localPortNumber\":[\"15432\"]}'"
    echo
    echo "    MIGRATION_DATABASE_URL='postgres://appuser:<口令>@localhost:15432/github_users' \\"
    echo "      ./scripts/perf-deploy.sh"
    echo
    echo "  表已经建好时可以用 SKIP_MIGRATION=1 跳过这一步。"
    exit 1
  fi
fi

blue "4 · 构建并推送清洗服务镜像"
aws ecr describe-repositories --repository-names "$REPO" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" >/dev/null
aws ecr get-login-password | docker login --username AWS --password-stdin \
  "$ACCOUNT_ID.dkr.ecr.$AWS_DEFAULT_REGION.amazonaws.com" >/dev/null
ok "已登录 ECR"

# ARM64 to match Fargate's cheaper Graviton tasks. This account has no
# CodeBuild concurrency, so the cross-build happens here (or in CI) via QEMU.
docker buildx build --platform linux/arm64 \
  -t "$IMAGE_URI" --push "$ROOT/perf-cleaner" >/dev/null
ok "镜像已推送 $IMAGE_URI"

blue "5 · 部署清洗服务（ECS + 目标组 + 监听规则）"
aws cloudformation deploy \
  --template-file "$ROOT/perf-cleaner/template.yaml" \
  --stack-name "$CLEANER_STACK" \
  --capabilities CAPABILITY_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "ImageUri=$IMAGE_URI" \
    "DatabaseUrl=$DATABASE_URL" \
    "ClusterName=$CLUSTER" \
    "VpcId=$VPC_ID" \
    "SubnetIds=$SUBNETS" \
    "SecurityGroupId=$SECURITY_GROUP" \
    "HttpsListenerArn=$LISTENER_ARN" \
    "LoadBalancerFullName=$LB_FULL_NAME" \
    "HostName=$HOST_NAME" \
    "RawLogGroupName=${RAW_LOG_GROUP:-/perf/raw}" \
    "AllowedOrigins=${DASHBOARD_ORIGINS:-}" \
  | tail -5

# A stack update that only changes the image leaves the task definition
# revision in place, so the running task has to be told to pick it up.
aws ecs update-service --cluster "$CLUSTER" --service zuoye-perf-cleaner-service \
  --force-new-deployment >/dev/null
echo "  等待服务稳定..."
aws ecs wait services-stable --cluster "$CLUSTER" --services zuoye-perf-cleaner-service
ok "清洗服务已上线"

blue "6 · 构建前端产物"
(cd "$ROOT/perf-sdk" && npm ci --silent && npm run build >/dev/null)
ok "SDK: perf-sdk/dist/perf-sdk.iife.js（$(du -h "$ROOT/perf-sdk/dist/perf-sdk.iife.js" | cut -f1 | tr -d ' ')）"

# VITE_INGEST_URL makes the dashboard report its own performance through the
# chain it displays. Left unset, the SDK import is tree-shaken away entirely,
# so a local build carries none of it.
(cd "$ROOT/perf-dashboard" && npm ci --silent \
  && VITE_PERF_API_URL="https://$HOST_NAME" \
     VITE_INGEST_URL="$INGEST_URL" \
     VITE_DEFAULT_SITE="${DEFAULT_SITE:-perf-dashboard}" \
     npm run build >/dev/null)
ok "看板: perf-dashboard/dist（已接入自监控）"

blue "完成"
echo "  上报端点   $INGEST_URL"
echo "  查询 API   https://$HOST_NAME/api/summary?site=<站点>&range=24h"
echo "  健康检查   https://$HOST_NAME/health"
echo
echo "  页面接入 SDK:"
echo "    <script src=\"/perf-sdk.iife.js\"></script>"
echo "    <script>PerfSDK.init({ endpoint: \"$INGEST_URL\", site: \"zuoye-frontend\" })</script>"
echo
echo "  看板发布: cd perf-dashboard && npx wrangler pages deploy dist"
