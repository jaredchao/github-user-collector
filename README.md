# GitHub User Collector

输入一个 GitHub 用户名，抓取公开信息存入 PostgreSQL，并生成一段中文个人介绍。

这是一个 AWS 全栈学习项目：Lambda、ECS Fargate、ALB、Cloud Map 服务发现、RDS、每个 PR 一套隔离的临时环境。完整搭建过程与 50 个踩坑记录见 [docs/学习笔记.md](docs/学习笔记.md)。

## 架构

Go 服务是唯一对外前门，前端只认一个后端域名；采集本身是异步的：

```
用户浏览器 ── Cloudflare Pages（前端）
    │
    └─ HTTPS ──> ALB:443（ACM 通配符证书 *.go-api.jccode.cc，host 头分流）
                    │
                    └──> Go 服务（ECS Fargate · ARM64 · 私有子网）
                           ├─ GET  /intro           → 查 RDS，拼接中文介绍
                           ├─ POST /users           → Cloud Map 发现 Lambda → Invoke
                           └─ GET  /users/{u}       → 同上（供轮询结果）
                                                  │
                                                  ▼
                                    Lambda（live 别名，非 $LATEST）
                                      POST → 投递 SNS，立即回 202
                                             │
                                    SNS ──> SQS ──> Worker Lambda ──> GitHub + RDS
                                                     │ 3 次仍失败
                                                     ▼
                                                死信队列 ──> 告警 ──> AlertsTopic

对内路（保留演示）：API Gateway /users/:u/intro → Lambda ── Cloud Map DNS ──> Go
巡检：Synthetics canary（每小时）打完整链路并校验数据新鲜度 ──> 告警 ──> AlertsTopic
```

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
| POST | `/users` | 请求体 `{"username":"torvalds"}`，投递采集请求，立即返回 `202` |
| GET | `/users/{username}` | 轮询采集结果；`404` + `{"status":"pending"}` 表示还在路上 |
| GET | `/intro?username=torvalds` | 返回该用户的中文介绍（需先入库） |
| GET | `/health` | 健康检查（含数据库连通性） |

采集是异步的：`POST` 只把请求交给 SNS，真正调用 GitHub 与写库由队列后面的 worker 完成，所以调用方拿到 202 后轮询 `GET /users/{username}` 取结果（通常 2-4 秒）。失败重试 3 次后进死信队列并告警。

错误码由 Lambda 原样透传：`400` 参数非法、`404` 尚未采集完成、`502` 采集服务不可达、`503` 采集服务未配置。

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
- **重试边界**：GitHub 404 视为已处理（重试无意义），限流/5xx/DB 错误才重试，坏消息进 DLQ。
- **灰度靠别名加权路由自建**（`scripts/canary-release.sh`），因为本账号无 CodeDeploy 订阅。
- **巡检校验数据新鲜度而非仅 200**：upsert 幂等，旧数据会让健康检查假绿。

更多取舍见学习笔记的「已知妥协」（共 7 条）。

## 待办

- [ ] CodeBuild 配额批准后把 `USE_CODEBUILD` 切回 `true`（预计 8 月初重申）
- [ ] 连接串改用 `sslmode=verify-full` 并附 RDS CA 证书
- [ ] 数据库密码迁移到 Secrets Manager
- [ ] 摘除本地 IAM 用户的 `IAMFullAccess`
- [ ] 演示结束后销毁全部 AWS 资源（清理顺序见学习笔记 §15）
