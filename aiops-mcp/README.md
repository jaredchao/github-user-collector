# AIOps MCP Server

把一套真实运行的 AWS 系统的运维能力，暴露成本地 Agent（Claude Code / Codex）可以直接调用的 MCP 工具。

大脑不自己造——用你已有的 Agent。这里提供的是**手**：一组边界清晰、语义明确、可安全调用的运维动作。

## 为什么不直接用通用的 AWS MCP

通用 MCP 把一万个 AWS API 交给 Agent，专用 MCP 交出去的是**十个运维动作**。

| | 通用 AWS MCP | 本服务器 |
|---|---|---|
| 查一次告警 | Agent 自己拼 `describe-alarms` 参数，再从原始 JSON 里找线索 | `list_alarms` 直接回“哪些在响” |
| 看死信队列 | 一不留神 `ReceiveMessage` 就把消息藏起来 30 秒 | `queue_depth` 强制零可见性超时，偷看不消费 |
| 回滚 | Agent 现拼别名权重 JSON，拼错就是事故 | 固化过的回滚动作，且强制先备份 |
| 安全边界 | 有凭证就能删库 | 工具即边界，只读的永远只读 |

**通用 MCP 给的是 API，专用 MCP 给的是被固化的判断力。**

## 工具

### 只读，标注 `readOnlyHint: true`，可以放心让 Agent 反复调用

| 工具 | 回答什么问题 |
|---|---|
| `list_alarms` | 现在有哪些告警在响 |
| `alarm_timeline` | 这个故障是什么时候开始的 |
| `deployment_state` | 那个时刻附近发过版本吗，现在跑的是哪个版本 |
| `queue_depth` | 积压了多少，死信消息长什么样 |
| `tail_logs` | 出错时日志里说了什么 |
| `check_ready` | 此刻整条链路到底通不通 |
| `list_restore_points` | 有哪些写操作可以撤销 |

### 写操作，标注 `destructiveHint: true`，默认只演练

| 工具 | 做什么 | 备份什么 |
|---|---|---|
| `set_alias_weight` | 把候选版本按权重接入流量 | 别名的版本与权重表 |
| `rollback_canary` | 取消灰度，流量收回稳定版本 | 同上 |
| `redrive_dlq` | 死信消息重放回主队列 | 消息原文 |
| `discard_dlq_messages` | 死信消息归档后删除 | 消息原文 |
| `restore` | 按还原点撤销某次写操作 | 不适用 |

另有资源 `aiops://topology`，返回实时发现的资源坐标。

## 写操作的三道闸

**一、默认演练。** 所有写工具的 `dryRun` 默认为 `true`，只返回执行计划。Agent 必须显式传 `dryRun=false` 才会真动手。加上 Claude Code 调用工具时本来就有的人工确认，等于两道关卡。

**二、备份先于变更。** 每个写操作的第一步是把将被覆盖的状态存成还原点，**备份失败则整个操作失败**——宁可什么都不做，也不做一件无法撤销的事。这条由测试锁死（见 `tests/aliasControl.test.ts` 与 `tests/dlqControl.test.ts` 中"备份失败就不删除"两例）。

**三、重放前先预检。** 死信队列里躺着两类东西：下游临时故障导致重试耗尽的消息（重放能成功），和格式本身非法的毒丸消息（重放一万次都是同样结果）。把毒丸消息重放回去，只会让它再消耗一轮重试、再回到死信队列，白白制造一轮告警。`redrive_dlq` 默认拒绝这类消息并指向 `discard_dlq_messages`。

顺序也是设计过的：`redrive` 是**先投主队列，再删死信原件**。万一投递成功而删除失败，结果是消息被重复处理一次——生成介绍是幂等的，重复无害；反过来先删再投，中间出错就是消息永久丢失。**在不可能两全的地方，选可恢复的那一侧。**

## 两个踩过的坑

**零可见性超时会让消息被反复取到。** 一次 `ReceiveMessage` 里同一条消息可能返回多次（`receiveCount` 一路递增），不去重的话 Agent 会把 1 条毒丸消息看成 3 条积压。更糟的是拉取循环只靠"批次为空"退出的话会死循环。

**演练不能有副作用。** 最初 `dryRun` 也用 120 秒可见性超时，导致演练完消息在队列上消失两分钟。而 Agent 的典型路径恰恰是"先演练 `redrive`，看到建议后立刻演练 `discard`"，第二步就会看到空队列，进而误报问题已解决。现在演练一律用零超时。

唯一躲不掉的副作用：每次偷看都会让 `ApproximateReceiveCount` 加一。SQS 没有真正的只读读法。死信队列本身没有重投策略，计数增长不会导致消息被再次转移，但读到的计数要按"含诊断次数"理解。

## 资源发现

不硬编码任何 ARN。所有资源坐标从 CloudFormation 栈实时发现，换栈只改环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `AIOPS_STACK_NAME` | `zuoye-collector` | 目标栈，指向 `zuoye-collector-pr-N` 即可运维 PR 环境 |
| `AIOPS_REGION` | `us-east-2` | 区域 |

AWS 凭证走标准链（`~/.aws/credentials` 或环境变量），服务器自身不持有任何密钥。

## 接入 Claude Code

仓库根目录的 `.mcp.json` 已配好，首次使用时 Claude Code 会提示批准。批准后直接提问即可：

```
现在系统有告警吗？如果有，帮我查清楚根因。
```

## 开发

```bash
npm install --registry=https://registry.npmjs.org   # 镜像站的 aws-sdk 依赖同步滞后
npm test          # 单元测试，不碰网络
npm run typecheck
npx tsx scripts/smoke.ts    # 拿真实 AWS 资源冒烟每个工具，全部只读
```

`scripts/smoke.ts` 补的是单元测试证明不了的那一段：IAM 权限够不够、资源名对不对得上、SDK 参数有没有写错。

## 还原点

写操作的备份落成本地 JSON 文件，默认在 `aiops-mcp/restore-points/`，可用 `AIOPS_RESTORE_DIR` 改。

刻意选了最笨的存储：**备份必须在最坏情况下也能读出来**。如果备份本身依赖一个可能同时出故障的云服务，那它在最需要的时刻恰好不可用。文件就在本地磁盘上，出事时 `cat` 一下就能看见。

`restore` 有一处必须讲清楚：别名类还原是真正的原样复位；消息类还原是把原文**重新投递**回原队列，如果那些消息在此期间已被正常处理，还原会导致重复处理。

## 无人值守：自动诊断栈

`template.yaml` 定义一个独立的 `zuoye-aiops` 栈：Lambda 订阅采集器栈的告警主题，告警进入 ALARM 时自动跑一轮**只读**诊断，把结论写进日志、推给飞书、落成多维表格工单。

栈刻意独立于被诊断的采集器栈——诊断能力不该与被诊断对象同生共死，后者被删掉时前者还要能回答"它是怎么没的"。

IAM 按最小权限逐项授权，并附一条覆盖全部变更动作的**显式 Deny**。它可以判断"该回滚了"，但不可以自己动手：无人值守的东西不该有手。

### 部署

```bash
cp aiops-mcp/deploy.env.example aiops-mcp/deploy.env   # 填凭证，此文件已 gitignore
./scripts/aiops-deploy.sh
./scripts/aiops-demo.sh                                # 验证
```

飞书相关的参数留空也能部署，届时通知与工单会以"未配置"的方式优雅跳过，不影响诊断本身。

### 飞书接入需要什么

| 用途 | 需要 | 备注 |
|---|---|---|
| 群通知 | 自定义机器人 webhook | 群设置 → 机器人 → 添加自定义机器人。**webhook 地址本身就是凭证** |
| 工单 | 自建应用的 App ID / Secret | 应用需申请 `base:app:read`、`base:record:create`、`base:record:retrieve` 并发布版本 |
| 工单 | 多维表格的 app_token / table_id | 已用 lark-cli 建好，坐标写在 `deploy.env.example` 里 |

工单表格与字段由 lark-cli 创建，应用也已加为编辑协作者。**但文档协作者权限和应用 scope 是两回事**——只加协作者、不申请 scope，bot 身份仍会被拒。

另有一个容易踩的坑：`base:record:read` 和 `base:record:retrieve` 是两个不同的权限，名字很像，但查重用的 `/records/search` 接口只认后者。只开前者时，开单会在运行时报 `99991672`，而部署阶段一切正常。

## 状态

14 个工具（9 只读 + 5 写）全部完成，129 个单元测试通过。只读工具已用真实 AWS 资源实测；写工具的演练路径已对真实死信队列验证，真实写入尚未执行。

自动诊断栈已部署，SNS 订阅链路实测通过（发布后 10 秒内触发，0 条权限错误）。飞书通知与工单待凭证配齐。

待办：远程 MCP 形态（Lambda + Function URL），还原点的 S3 存储实现。
