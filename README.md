# GitHub User Collector

输入一个 GitHub 用户名，抓取公开信息存入 PostgreSQL，并生成一段中文个人介绍。

这是一个 AWS 全栈学习项目：Lambda、ECS Fargate、ALB、Cloud Map 服务发现、RDS、每个 PR 一套隔离的临时环境。完整搭建过程与 50 个踩坑记录见 [docs/学习笔记.md](docs/学习笔记.md)。

## 架构

Go 服务是唯一对外前门；保存 Profile 是同步的，生成介绍是异步的：

```
用户浏览器 ── Cloudflare Pages（前端）
    │
    └─ HTTPS ──> ALB:443（ACM 通配符证书 *.go-api.jccode.cc，host 头分流）
                    │
                    └──> Go 服务（ECS Fargate · ARM64 · 私有子网）
                           ├─ POST /users     → Cloud Map 发现 Lambda → Invoke
                           ├─ GET  /users/{u} → 同上
                           └─ GET  /intro     → 读已生成的介绍（未生成回 404）
                                                  │
                                                  ▼
                                    Lambda（live 别名，非 $LATEST）
                                      抓 GitHub → 写 RDS → 201 Created
                                             │ 保存成功后 best-effort
                                             ▼
                        SNS profile.saved ──> SQS IntroductionQueue
                                                     │
                                              Worker Lambda ──> Go 服务 ──> RDS
                                                     │ 重试 5 次仍失败
                                                     ▼
                                          死信队列（14 天）──> 告警 ──> AlertsTopic

对内路（保留演示）：API Gateway /users/:u/intro → Lambda ── Cloud Map DNS ──> Go
就绪检查：GET /ready 一次走通 API GW → Lambda → Go → PostgreSQL，供巡检调用
```

**主请求不因异步失败而回滚**：Profile 已经提交，发布事件失败只让响应带上 `introductionQueued: false`，不会把成功的保存变成失败的请求。

Cloud Map 的两种形态都在使用：

| | Lambda → Go（对内路） | Go → Lambda（搜索转发） |
|---|---|---|
| 命名空间 | `zuoye.internal`（DNS 型） | `zuoye.api`（HTTP 型） |
| 注册内容 | 容器私网 IP（A 记录） | 函数名/ARN（属性） |
| 发现方式 | DNS 解析 | `DiscoverInstances` API |
| 调用方式 | HTTP 直连 | AWS SDK `Invoke`（构造 API Gateway v2 事件，Lambda 代码无感） |

Lambda、Go 容器、RDS、跳板机均无公网 IP；RDS 的 5432 仅对 Lambda、Go 与跳板机的安全组开放。

## 仓库结构

```
backend/     Hono API（Lambda），SAM 模板，数据库迁移
go-service/  Go 个人介绍服务（ECS Fargate），vendor 依赖随仓库
frontend/    Vite + React 单页应用
aiops-mcp/   AI Ops Agent 的 MCP 服务器与自动诊断 Lambda
scripts/     PR 环境的建立/拆除脚本（幂等）
.github/     GitHub Actions 工作流
docs/        学习笔记与设计文档
```

## 线上入口

| 环境 | 地址 |
|------|------|
| 生产前端 | https://zuoye-frontend.pages.dev |
| 生产 Go 前门 | https://main.go-api.jccode.cc |
| Lambda API（对内路演示） | https://kp6eccqn9h.execute-api.us-east-2.amazonaws.com |
| PR 预览 | 开 PR 后机器人评论里的 `pr-N.*` 链接，关 PR 自动销毁 |

## 接口（Go 前门）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/users` | 请求体 `{"username":"torvalds"}`，同步抓取入库并返回 `201` |
| GET | `/users/{username}` | 读取已保存的 Profile |
| GET | `/intro?username=torvalds` | 读取已生成的介绍；`404` 表示还在生成中 |
| GET | `/health` | 存活检查（含数据库连通性） |

Lambda 侧额外提供 `GET /ready`：一次调用验证 `API Gateway → Lambda → Go → PostgreSQL` 整条链路，不碰用户数据，供巡检使用。

介绍是异步生成的：保存成功后发出 `profile.saved`，Worker 消费后调 Go 服务渲染并落库，所以前端拿到 Profile 后轮询 `/intro` 等它出现（通常 2-4 秒）。失败重试 5 次后进死信队列并告警。

## PR 临时环境

原则：**改哪块，起哪块；没改的用生产**。

| PR 改了什么 | 前端预览 | Go 前门 pr-N | Lambda 栈 pr-N |
|---|---|---|---|
| 只改 `frontend/` | ✓（连生产 Go） | 生产 | 生产 |
| 只改 `go-service/` | ✓ | ✓ | 生产 |
| 只改 `backend/` | ✓ | ✓（Cloud Map 目标切到 pr-N 栈） | ✓ |
| 全改 | ✓ | ✓ | ✓ 全链路本 PR 代码 |

开 PR：OIDC 换临时凭证 → buildx 构建 ARM64 镜像推 ECR / SAM 部署 `zuoye-collector-pr-N` 栈 / Pages 预览部署 → 可点链接评论回 PR。追加提交幂等刷新。

关 PR：三路并行清理——Go 前门五资源（任务定义/服务/目标组/ALB 规则/Cloud Map）+ 镜像，Lambda 整栈，Pages 预览部署。零计费残留。

## 验证

```bash
./scripts/verify.sh                  # 三个任务的实时证据，约 1 分钟
./scripts/verify.sh --dlq            # 额外演示死信队列，约 15 分钟
./scripts/synthetics-changeset.sh    # 巡检资源就绪证据，不改动生产栈
./scripts/aiops-demo.sh              # AI Ops Agent 全链路，约 2 分钟
```

脚本会依次证明：采集前 `/intro` 是 404（说明读的是持久化值，不是实时拼接）、`POST /users` 同步返回 201、介绍在两三秒后由异步链路补上并留下 Worker 日志、API Gateway 打的是 `live` 别名而非 `$LATEST`、两条回滚门禁告警的状态、以及 `/ready` 一次走通整条技术链路。

也可以直接打开 https://zuoye-frontend.pages.dev 搜一个没搜过的用户：卡片立即出现、介绍稍后补上，就是这套异步架构在用户侧的样子。

想在 AWS 控制台里逐个点开看（队列的重试策略、别名的灰度权重、告警状态、真实日志），见 [docs/控制台导览.md](docs/控制台导览.md)。

## AI Ops Agent

上面这套系统会出故障，而这一层负责诊断它。

**大脑不自己造**——用你本地已有的 Claude Code 或 Codex。这里提供的是**手**：一个自建的 MCP 服务器，把运维能力封装成 Agent 能安全调用的工具。

```
本地 Claude Code / Codex ──MCP──> aiops-mcp（14 个工具）──AWS SDK──> 真实资源
                                        ▲
CloudWatch 告警 ──SNS──> 诊断 Lambda ────┘   同一份 tools/，两种承载
                              │
                              └─> incident 记录 + 飞书通知 + 多维表格工单
```

### 为什么不直接用通用的 AWS MCP

| | 通用 AWS MCP | 本项目 |
|---|---|---|
| 交给 Agent 的 | 一万个 API | 十几个运维动作 |
| 看死信队列 | 一不留神 `ReceiveMessage` 就把消息藏起 30 秒 | 强制零可见性超时，偷看不消费 |
| 回滚 | 现拼别名权重 JSON，拼错就是事故 | 固化过的动作，且强制先备份 |
| 安全边界 | 有凭证就能删库 | 工具即边界，只读的永远只读 |

**通用 MCP 给的是 API，专用 MCP 给的是被固化的判断力。**

`diagnose` 一次调用跑完整套 runbook（定位故障起点 → 比对发布时间 → 按告警类型取证 → 检查链路 → 看指标趋势），并把时间关联算好。对生产环境实测的输出：

```
1 个告警正在触发。但系统此刻是健康的，重点看告警是否陈旧。发现 4 条关联。
  - 进入 ALARM 的时刻与最近一次发布相差 66 小时，与发布无关
  - 就绪检查通过且窗口内没有新的错误日志——故障可能已经过去，告警是陈旧的
  - 死信队列里的样本全部格式非法，重放必然再次失败——这是数据问题，不是系统故障
  - 最老的死信消息已入队 67 小时，说明没人处理过它
建议动作: 用 discard_dlq_messages 归档后丢弃，不要重放
```

### 写操作的三道闸

9 个只读工具带 `readOnlyHint`，5 个写工具带 `destructiveHint`。写操作要过三道闸：

1. **默认演练**——`dryRun` 默认 `true`，只返回执行计划；加上 Claude Code 自带的人工确认，等于两道关卡
2. **备份先于变更**——先存还原点，**备份失败则整个操作失败**。宁可什么都不做，也不做一件无法撤销的事
3. **重放前预检**——格式非法的毒丸消息重放必然再次失败，默认拒绝并改荐丢弃

配套 `restore` 工具，撤销本身也是 Agent 能调的能力。还原点落成本地 JSON 文件而非 S3：备份必须在最坏情况下也能读出来，不该依赖一个可能与故障同时发生的云服务。

### 无人值守

`zuoye-aiops` 栈订阅告警主题，告警进入 ALARM 时自动跑一轮**只读**诊断，写下 incident 记录并推送通知。它可以判断"该回滚了"，但 IAM 角色带一条覆盖全部变更动作的**显式 Deny**——无人值守的东西不该自己动手。

```bash
./scripts/aiops-demo.sh            # 只读演示，约 2 分钟
./scripts/aiops-demo.sh --inject   # 先注入一条毒丸消息制造真故障
```

细节见 [aiops-mcp/README.md](aiops-mcp/README.md)，踩坑记录见学习笔记第 18 节。

### 演示灰度回滚

想亲眼看一次"坏版本只伤 10% 流量、两分钟自动回滚"：

```bash
FN=$(aws cloudformation describe-stacks --stack-name zuoye-collector \
  --query 'Stacks[0].Outputs[?OutputKey==`FunctionName`].OutputValue' --output text)
STABLE=$(aws lambda get-alias --function-name $FN --name live \
  --query FunctionVersion --output text)

# 1. 发布一个必然出错的版本作为候选
mkdir -p /tmp/bad && cd /tmp/bad
echo 'export const handler = async () => { throw new Error("bad"); };' > index.mjs
zip -q bad.zip index.mjs
aws lambda update-function-code --function-name $FN --zip-file fileb://bad.zip >/dev/null
aws lambda wait function-updated --function-name $FN
BAD=$(aws lambda publish-version --function-name $FN --query Version --output text)

# 2. 一边打流量（没有流量的灰度是无效的灰度），一边灰度发布
API=$(aws cloudformation describe-stacks --stack-name zuoye-collector \
  --query 'Stacks[0].Outputs[?OutputKey==`ApiUrl`].OutputValue' --output text)
while true; do curl -s -o /dev/null "$API/health"; sleep 1; done &   # 另开一个终端也行
STABLE=$STABLE BAKE=300 ./scripts/canary-release.sh $BAD

# 3. 收尾：恢复 $LATEST 的好代码，删掉坏版本
cd backend && npm run build && cd dist && zip -q good.zip index.mjs worker.mjs
aws lambda update-function-code --function-name $FN --zip-file fileb://good.zip >/dev/null
aws lambda delete-function --function-name "$FN:$BAD"
```

预期输出是告警在两分钟内触发、脚本自动把 100% 流量推回稳定版。

## 本地开发

前置：Node.js 22+、Go 1.26+、Docker。

```bash
# 数据库
cd backend && docker compose up -d && npm run migrate

# Lambda API（localhost:3100）
npm install && cp .env.example .env && npm run dev

# Go 服务（localhost:8080；本地无任务角色时 POST /users 返回 503，属预期）
cd ../go-service && cp .env.example .env && go run ./cmd/server

# 前端（localhost:5173）
cd ../frontend && npm install && npm run dev
```

测试：

```bash
cd backend    && npm test && npm run typecheck
cd frontend   && npm test && npm run typecheck
cd go-service && go test ./...
```

`db.test.ts` 连接 Docker 中的真实 PostgreSQL——`ON CONFLICT` 是数据库特有行为，mock 掉就失去了测试意义。

## CI/CD 与身份

推送 `main` 按路径自动部署：`frontend/**` → Pages 发布；`backend/**` → SAM 部署 + 冒烟。PR 事件触发上述临时环境。

全程 GitHub Actions OIDC 临时凭证，**仓库不持有任何 AWS 长期密钥**。四个 IAM 角色各司其职：

| 角色 | 谁扮演 | 权限边界 |
|------|--------|---------|
| `zuoye-github-actions-deploy` | CI（main 与 PR） | SAM 栈的创建/删除 |
| `zuoye-github-oidc-role` | CI（PR 编排） | pr-N 的 ECS/ALB/CloudMap/ECR 资源 |
| `zuoye-go-task-role` | Go 容器运行时 | `DiscoverInstances` + `lambda:InvokeFunction` |
| `zuoye-ecs-execution-role` | ECS 启动任务 | 拉镜像、写日志 |

OIDC 角色信任策略的 `sub` 用 `StringEquals` 精确匹配本仓库——fork 的 PR 拿不到 secrets 也签不出 OIDC 令牌，部署类 job 对外来 PR 天然失效。

镜像构建的预期路径是 CodeBuild（项目、buildspec、S3 源桶均已就绪），但新账号并发配额被锁 0、提额被拒，目前由 workflow 里的 buildx/QEMU 交叉构建顶替，`USE_CODEBUILD` 开关一词切回。

### 仓库 Secrets

| 名称 | 用途 |
|------|------|
| `AWS_DEPLOY_ROLE_ARN` | SAM 部署角色 |
| `DATABASE_URL` | RDS 连接串（含密码） |
| `SUBNET_ID_A` / `SUBNET_ID_B` | 私有子网 |
| `LAMBDA_SECURITY_GROUP_ID` | Lambda 安全组 |
| `CLOUDFLARE_API_TOKEN` | 仅授予 `Cloudflare Pages: Edit` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账号标识 |

## 设计说明（节选）

- **Lambda 连接池位于模块作用域**，容器冻结复用；`max: 2` 因单实例串行处理。
- **Go 服务 vendor 全部依赖**，构建不出网；镜像多阶段构建到 `scratch`，几 MB。
- **Go 调 Lambda 构造 API Gateway v2 事件**，`hono/aws-lambda` 适配器无感，状态码原样透传。
- **PR 任务定义克隆生产版**，`DATABASE_URL` 不经过 GitHub。
- **数据库密码存于环境变量**是有意识的成本权衡，生产应迁 Secrets Manager。
- **重试边界**：Profile 不存在视为已处理（重试无意义），Go 不可达/5xx 才重试，坏事件进 DLQ。
- **灰度靠别名加权路由自建**（`scripts/canary-release.sh`），因为本账号无 CodeDeploy 订阅。
- **`/intro` 读持久化值而非实时拼接**：否则 Worker 全挂时读接口照样返回内容，巡检假绿。
- **两处受账号限制**：无 CodeDeploy 订阅、Lambda 内存上限 512MB，所以灰度用别名加权路由脚本、Synthetics 开关默认关闭（配额申请中）。canary 建不出来不是配置问题——换区域、把 `MemoryInMB` 调到 512、换探测目标都试过，960 是 Synthetics API 的硬下限，而它底层就是一个建在你账号里的 Lambda。资源本身已就绪，`scripts/synthetics-changeset.sh` 让 CloudFormation 确认这一点。

更多取舍见学习笔记的「已知妥协」（共 7 条）。

## 待办

- [ ] CodeBuild 配额批准后把 `USE_CODEBUILD` 切回 `true`（预计 8 月初重申）
- [ ] 连接串改用 `sslmode=verify-full` 并附 RDS CA 证书
- [ ] 数据库密码迁移到 Secrets Manager
- [ ] 摘除本地 IAM 用户的 `IAMFullAccess`
- [ ] 演示结束后销毁全部 AWS 资源（清理顺序见学习笔记 §15）
