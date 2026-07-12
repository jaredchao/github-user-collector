# Go 个人介绍服务 —— 设计文档（作业二 · 阶段 1）

## 目标

用 Go 写一个**只读** HTTP 服务：从现有 RDS PostgreSQL 的 `github_users` 表读取某个 GitHub 用户，用字段拼接（非 AI）生成一段中文个人介绍返回。本阶段只要求本地跑通；阶段 2 会容器化上 ECS Fargate，阶段 3 做 PR 临时环境。

数据库、表、数据均已存在（作业一 Node 版抓取并写入）。本服务不抓 GitHub、不写库。

## 与 Node 版的本质区别：只读

| 能力 | Node 版（作业一） | Go 版（本服务） |
|------|------------------|----------------|
| 连 GitHub API | 抓取 | 不连 |
| 写数据库 | upsert | 不写 |
| 读数据库 | — | 只读 |
| 生成介绍 | — | 字段拼接 |

因此 Go 版更简单：无网络抓取、无写入、无冲突处理，只有「查一行 → 拼字符串 → 返回」。

## 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| 语言 | Go 1.26 | 作业指定 |
| PG 驱动 | `github.com/jackc/pgx/v5`（pgxpool） | 社区主流、性能好、连接池内置、context 原生 |
| HTTP | 标准库 `net/http`（Go 1.22+ 路由） | 无需框架，依赖少，容器镜像小 |
| 测试 | 标准库 `testing` + `net/http/httptest` | 零额外依赖 |

## 接口

```
GET /intro?username=torvalds   → 200 + {username, intro}
GET /health                    → 200（ALB / CloudMap 探活用）
```

成功响应：

```json
{
  "username": "torvalds",
  "intro": "Linus Torvalds（@torvalds）来自 Portland, OR，就职于 Linux Foundation。目前有 12 个公开仓库，310,967 位关注者。GitHub 账号注册于 2011 年。"
}
```

## 目录结构

```
go-service/
├─ cmd/server/main.go        入口：读配置、建连接池、起 HTTP 服务
├─ internal/
│  ├─ store/                 pgxpool 连接 + 按 username 查一行
│  │  ├─ store.go
│  │  └─ store_test.go       连真实 PG（经隧道）
│  ├─ intro/                 纯函数：User → 介绍字符串
│  │  ├─ intro.go
│  │  └─ intro_test.go       纯单元测，不碰数据库
│  └─ server/                HTTP handler、参数校验、错误→状态码
│     ├─ server.go
│     └─ server_test.go      httptest 测路由
├─ go.mod / go.sum
├─ .env.example
└─ Dockerfile                阶段 2 用
```

依赖方向单向：`main → server → {store, intro}`。`intro` 与 `store` 互不依赖，可独立测试。`internal/` 内的包只能被本模块导入。

## 表结构（只读）

```sql
github_users(
  id, username, github_id,
  name, avatar_url, bio, company, location,       -- 可空
  public_repos, followers, following,             -- NOT NULL DEFAULT 0
  github_created_at,                               -- 可空
  created_at, updated_at
)
```

本服务只 SELECT，用到：`username, name, bio, company, location, public_repos, followers, github_created_at`。

## 介绍拼接规则（intro.Build）

null 是常态（多数用户不填 company/location），遇到 null 的字段整句跳过。

```
主句(必有):  "{name 或 username}（@{username}）"
地点(可选):  location  非空 → "来自 {location}"
公司(可选):  company   非空 → "就职于 {company}"
统计(必有):  "目前有 {public_repos} 个公开仓库，{followers} 位关注者。"
注册(可选):  github_created_at 非空 → "GitHub 账号注册于 {年} 年。"
简介(可选):  bio 非空 → 附在最后
```

`name` 为空时回落到 `username`，保证主句永远成立。

示例：

| 数据 | 输出 |
|------|------|
| 字段全 | Linus Torvalds（@torvalds）来自 Portland, OR，就职于 Linux Foundation。目前有 12 个公开仓库，310,967 位关注者。GitHub 账号注册于 2011 年。 |
| 缺 company/location | octocat（@octocat）目前有 8 个公开仓库，5,000 位关注者。 |
| name 为空 | ghost（@ghost）目前有 0 个公开仓库，0 位关注者。 |

## 错误处理

Go 错误是返回值而非异常。各层向上返回错误，`server` 层统一翻译为状态码。

| 情况 | 状态码 |
|------|--------|
| 缺 username / 格式非法 | 400 |
| 用户不存在（`pgx.ErrNoRows`） | 404 |
| 数据库连接/查询失败 | 500 |

业务层不出现 HTTP 状态码。

## 配置

单一环境变量：

```
DATABASE_URL=postgres://postgres:<密码>@localhost:5433/github_users?sslmode=no-verify
```

- 本地：指向 SSM 隧道的 `localhost:5433`
- 阶段 2 容器：指向 RDS 真实端点 `...rds.amazonaws.com:5432`

**必须显式带 `sslmode=no-verify`**：RDS 强制 SSL（`rds.force_ssl=1`），而经隧道连 `localhost` 时证书主机名不匹配，严格校验会失败。pgx 默认 `sslmode=prefer` 不够。

`.env` 不纳入版本控制。

## 测试（TDD）

| 对象 | 方式 |
|------|------|
| `intro.Build` | 纯函数。每种 null 组合各一用例：全字段、缺 company/location、name 为空、bio 有无 |
| `store` | 连真实 PG（经隧道）：查已存在用户、查不存在返回 ErrNoRows |
| `server` | `httptest`：200 / 400 / 404 / health |

`store` 连真库而非 mock：SQL 与 `pgx.ErrNoRows` 行为无法 mock。

## 阶段 2 伏笔

Go 编译为单个静态二进制，阶段 2 可做极小容器镜像（多阶段构建 + `scratch`/`distroless`，约几 MB，对比 Node 数十 MB）。因此代码只依赖纯 Go 库（pgx 满足），不引入需要动态链接（cgo）的依赖。

## 非目标（本阶段不做）

- 不写数据库、不抓 GitHub
- 不做容器化、不上云（阶段 2）
- 不做 CI/CD、PR 环境（阶段 3）
- 介绍不接 AI，纯字段拼接
