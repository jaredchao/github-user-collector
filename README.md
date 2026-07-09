# GitHub User Collector

抓取 GitHub 用户信息并存入 PostgreSQL。本地以 Hono HTTP 服务运行，部署到 AWS Lambda + API Gateway，数据库使用 VPC 私有子网中的 RDS。

## 接口

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/users` | 请求体 `{"username": "torvalds"}`，抓取该用户并写库，返回 `201` |
| GET | `/health` | 健康检查 |

`POST /users` 对同一用户名重复调用会更新已有记录（upsert），不会产生重复行。

### 状态码

| 码 | 含义 |
|----|------|
| `201` | 抓取并写入成功 |
| `400` | 请求体不是合法 JSON，或 `username` 缺失／不符合 GitHub 用户名格式 |
| `404` | GitHub 上不存在该用户 |
| `429` | GitHub API 限流（匿名调用配额为 60 次/小时） |
| `502` | GitHub 返回 5xx 或请求超时 |
| `500` | 数据库等内部故障 |

## 本地开发

前置：Node.js 22+、Docker。

```bash
npm install
cp .env.example .env
docker compose up -d     # 启动 PostgreSQL
npm run migrate          # 建表
npm run dev              # 服务监听 localhost:3100
```

验证：

```bash
curl -X POST localhost:3100/users \
  -H 'Content-Type: application/json' \
  -d '{"username":"torvalds"}'
```

## 测试

```bash
npm test         # 全部用例
npm run typecheck
```

`db.test.ts` 连接 Docker 中的真实 PostgreSQL 运行——`ON CONFLICT` 是数据库特有行为，mock 掉就失去了测试意义。运行前需先 `docker compose up -d`。

## 构建 Lambda 部署包

```bash
npm run package    # 产出 lambda.zip，内含打包后的单文件 dist/index.mjs
```

esbuild 将全部依赖打进一个文件，因此无需上传 `node_modules`。Lambda 配置：

- 运行时 `nodejs22.x`
- 处理程序 `index.handler`
- 环境变量 `DATABASE_URL` 指向 RDS 端点

## 结构

```
src/
  github.ts    调用 GitHub API，返回领域对象；不涉及数据库
  db.ts        连接池与 upsert；不涉及 HTTP
  service.ts   编排层：fetchAndStore = fetchUser + upsertUser
  app.ts       Hono 路由、入参校验、错误到状态码的映射
  local.ts     本地入口（@hono/node-server）
  lambda.ts    部署入口（hono/aws-lambda）
```

依赖方向单向：`local|lambda → app → service → {github, db}`。`github.ts` 与 `db.ts` 互不依赖，可独立测试与替换。

## 设计说明

**连接池位于模块作用域。** Lambda 在两次调用之间冻结容器而非销毁，池建在 handler 内部会导致每次请求新建连接并迅速耗尽 RDS 连接数。`max: 2` 是因为单个 Lambda 实例同时只处理一个请求。

**唯一约束只加在 `username`。** GitHub 用户可以改名，若 `github_id` 也设唯一约束，改名后 upsert 会同时命中两个冲突键，语义不确定。

**GitHub 请求设 5 秒超时。** 否则上游无响应时 Lambda 会一直挂到自身超时。

**数据库密码目前存于环境变量。** 生产环境应迁移至 AWS Secrets Manager，由 Lambda 在运行时读取。

## 待办

- [ ] 搭建 VPC（公有／私有子网、Internet Gateway、NAT Gateway、路由表）
- [ ] 创建 RDS PostgreSQL 实例于私有子网
- [ ] 部署 Lambda 并接入 VPC
- [ ] 配置 API Gateway
- [ ] 将数据库密码迁移到 Secrets Manager
