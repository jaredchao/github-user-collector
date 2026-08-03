import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { topology } from "./config.js";
import { guard, ok } from "./toolResult.js";
import { rollbackCanary, setAliasWeight } from "./tools/aliasControl.js";
import { alarmTimeline } from "./tools/alarmTimeline.js";
import { checkReady } from "./tools/checkReady.js";
import { deploymentState } from "./tools/deploymentState.js";
import { discardDlqMessages, redriveDlq } from "./tools/dlqControl.js";
import { queueDepth } from "./tools/dlqDepth.js";
import { listAlarms } from "./tools/listAlarms.js";
import { getMetrics } from "./tools/metrics.js";
import { listRestorePoints, restore } from "./tools/restoreTool.js";
import { tailLogs } from "./tools/tailLogs.js";

/** 只读工具的统一标注：可以放心重复调用，不会改变任何状态。 */
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

/** 写工具的统一标注：会改变线上状态，客户端应当向人确认。 */
const mutating = { readOnlyHint: false, destructiveHint: true, idempotentHint: false };

const dryRunField = z
  .boolean()
  .default(true)
  .describe(
    "默认 true，只返回执行计划而不实际改动。确认计划无误后传 false 才会真正执行。",
  );

export const createServer = (): McpServer => {
  const server = new McpServer(
    { name: "aiops-mcp", version: "1.0.0" },
    {
      instructions: [
        "这个服务器把一套真实运行的 AWS 系统（API Gateway + Lambda + SNS/SQS + ECS 上的 Go 服务 + RDS）",
        "的运维能力暴露为工具。诊断故障时的推荐顺序：",
        "1. list_alarms 看哪些告警在响",
        "2. alarm_timeline 确定故障起点",
        "3. deployment_state 看那个时刻附近有没有发过版本",
        "4. queue_depth / tail_logs 收集具体证据",
        "5. check_ready 确认当前链路是否通",
        "先形成证据链再下结论，不要凭单一指标判断根因。",
      ].join("\n"),
    },
  );

  server.registerResource(
    "topology",
    "aiops://topology",
    {
      title: "被运维系统的资源拓扑",
      description: "函数名、队列地址、告警清单、日志组等资源坐标，全部从 CloudFormation 栈实时发现",
      mimeType: "application/json",
    },
    async (uri) => {
      const topo = await topology();
      return {
        contents: [
          { uri: uri.href, mimeType: "application/json", text: JSON.stringify(topo, null, 2) },
        ],
      };
    },
  );

  server.registerTool(
    "list_alarms",
    {
      title: "列出全部告警状态",
      description:
        "列出被运维栈的所有 CloudWatch 告警及其当前状态。排查任何问题都从这里开始。",
      inputSchema: {},
      annotations: readOnly,
    },
    async () =>
      guard(async () => {
        const result = await listAlarms();
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "alarm_timeline",
    {
      title: "查看告警的状态变更时间线",
      description:
        "某个告警在过去若干小时内的状态变更历史，用来确定故障是什么时候开始的。" +
        "拿到起点后，去和 deployment_state 的发布时间做关联。",
      inputSchema: {
        alarmName: z.string().describe("告警全名，从 list_alarms 的结果里取"),
        hours: z.number().int().min(1).max(336).default(24).describe("回溯多少小时"),
      },
      annotations: readOnly,
    },
    async ({ alarmName, hours }) =>
      guard(async () => {
        const result = await alarmTimeline(alarmName, hours);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "queue_depth",
    {
      title: "查看队列积压与消息样本",
      description:
        "查看死信队列或主队列的积压情况。sampleSize 大于 0 时会偷看几条消息内容，" +
        "偷看使用零可见性超时，不会消费掉消息。死信队列里的消息体是判断故障类型的关键证据。" +
        "想知道消息到底卡了多久，必须传 sampleSize > 0：CloudWatch 的可见时长指标会被" +
        "每一次接收（包括诊断时的偷看）重置，只有消息自带的 SentTimestamp 是不变量。",
      inputSchema: {
        queue: z
          .enum(["dead-letter", "main"])
          .default("dead-letter")
          .describe("看死信队列还是主队列"),
        sampleSize: z
          .number()
          .int()
          .min(0)
          .max(10)
          .default(0)
          .describe("偷看几条消息内容，0 表示只看数量"),
      },
      annotations: readOnly,
    },
    async ({ queue, sampleSize }) =>
      guard(async () => {
        const result = await queueDepth(queue, sampleSize);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "deployment_state",
    {
      title: "查看当前发布状态",
      description:
        "别名指向哪个版本、是否正在灰度、各版本的代码指纹与发布时间。" +
        "这是回答“最近改过什么”的权威来源。",
      inputSchema: {
        alias: z.string().default("live").describe("Lambda 别名名称"),
      },
      annotations: readOnly,
    },
    async ({ alias }) =>
      guard(async () => {
        const result = await deploymentState(alias);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "tail_logs",
    {
      title: "捞最近的错误日志",
      description:
        "用 CloudWatch Logs Insights 查最近匹配错误模式的日志。" +
        "返回的是筛选后的少量记录而非日志转储，适合直接读。查询需要几秒。",
      inputSchema: {
        target: z
          .enum(["collector", "worker", "go-service"])
          .default("worker")
          .describe(
            "collector 是 API 主函数，worker 是异步介绍生成函数，" +
              "go-service 是 ECS 上的 Go 前门——用户请求最先到达的地方",
          ),
        minutes: z.number().int().min(1).max(1440).default(30).describe("回溯多少分钟"),
        pattern: z
          .string()
          .optional()
          .describe("正则模式，留空则匹配常见错误关键词"),
        limit: z.number().int().min(1).max(100).default(20).describe("最多返回几条"),
      },
      annotations: readOnly,
    },
    async ({ target, minutes, pattern, limit }) =>
      guard(async () => {
        const result = await tailLogs(target, minutes, pattern, limit);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "get_metrics",
    {
      title: "查看关键指标与趋势",
      description:
        "取 Lambda、API Gateway、SQS、ECS 的关键指标，返回最新值、均值、峰值和趋势方向。" +
        "告警只是越过阈值后的二值信号——错误率从 0.1% 涨到 1.9%（阈值 2%）时告警仍是绿的，" +
        "但系统已经在恶化。想知道“是否正在变坏”而不只是“是否已经坏了”，用这个工具。",
      inputSchema: {
        scopes: z
          .array(z.enum(["lambda", "api", "queue", "ecs"]))
          .default(["lambda", "api", "queue"])
          .describe("要查哪几类指标"),
        minutes: z.number().int().min(5).max(1440).default(60).describe("回溯多少分钟"),
      },
      annotations: readOnly,
    },
    async ({ scopes, minutes }) =>
      guard(async () => {
        const result = await getMetrics(scopes, minutes);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "check_ready",
    {
      title: "端到端就绪检查",
      description:
        "打一次 /ready，用一个请求验证 API Gateway、Lambda、Go 服务、PostgreSQL 是否全部可用。" +
        "处置之后用它确认系统真的恢复了。",
      inputSchema: {},
      annotations: { ...readOnly, idempotentHint: false },
    },
    async () =>
      guard(async () => {
        const result = await checkReady();
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "set_alias_weight",
    {
      title: "设置灰度权重",
      description:
        "把某个候选版本按权重接入线上流量。执行前会自动把别名当前配置存成还原点。",
      inputSchema: {
        candidateVersion: z.string().describe("候选版本号，例如 4"),
        weight: z
          .number()
          .gt(0)
          .lt(1)
          .describe("候选版本承接的流量比例，0 到 1 之间，例如 0.1 表示 10%"),
        alias: z.string().default("live").describe("Lambda 别名名称"),
        dryRun: dryRunField,
      },
      annotations: mutating,
    },
    async ({ candidateVersion, weight, alias, dryRun }) =>
      guard(async () => {
        const result = await setAliasWeight(candidateVersion, weight, dryRun, alias);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "rollback_canary",
    {
      title: "回滚灰度",
      description:
        "取消灰度并把全部流量收回稳定版本。不传 targetVersion 时收回到别名当前主版本，" +
        "也就是摘掉候选版本；传了则连主版本一起切，用于回滚一个已全量上线的坏版本。" +
        "执行前会自动把别名当前配置存成还原点。",
      inputSchema: {
        targetVersion: z
          .string()
          .optional()
          .describe("要回到的稳定版本号，留空表示只摘掉候选版本"),
        alias: z.string().default("live").describe("Lambda 别名名称"),
        dryRun: dryRunField,
      },
      annotations: mutating,
    },
    async ({ targetVersion, alias, dryRun }) =>
      guard(async () => {
        const result = await rollbackCanary(targetVersion, dryRun, alias);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "redrive_dlq",
    {
      title: "重放死信消息",
      description:
        "把死信队列里的消息重放回主队列。会先做可行性预检：格式非法的毒丸消息重放必然" +
        "再次失败，默认会拒绝执行并建议改用 discard_dlq_messages。带 force=true 可跳过" +
        "毒丸消息、只重放其余的。执行前消息原文会先存成还原点。",
      inputSchema: {
        maxMessages: z.number().int().min(1).max(100).default(10).describe("最多处理几条"),
        force: z
          .boolean()
          .default(false)
          .describe("队列里混有毒丸消息时，是否跳过它们只重放可重放的那些"),
        dryRun: dryRunField,
      },
      annotations: mutating,
    },
    async ({ maxMessages, force, dryRun }) =>
      guard(async () => {
        const result = await redriveDlq(maxMessages, dryRun, force);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "discard_dlq_messages",
    {
      title: "归档并丢弃死信消息",
      description:
        "把死信消息原文存成还原点后从队列删除。这是毒丸消息的正确处置方式——它们重放" +
        "多少次都会失败，留在队列里只会让告警一直响。删除是唯一真正不可逆的操作，" +
        "所以备份在这里绝不跳过。",
      inputSchema: {
        maxMessages: z.number().int().min(1).max(100).default(10).describe("最多处理几条"),
        dryRun: dryRunField,
      },
      annotations: mutating,
    },
    async ({ maxMessages, dryRun }) =>
      guard(async () => {
        const result = await discardDlqMessages(maxMessages, dryRun);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "list_restore_points",
    {
      title: "列出还原点",
      description:
        "列出历次写操作留下的还原点，最近的在前。想撤销某次操作时先来这里找 ID。",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("最多返回几个"),
      },
      annotations: readOnly,
    },
    async ({ limit }) =>
      guard(async () => {
        const result = await listRestorePoints(limit);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "restore",
    {
      title: "按还原点撤销一次写操作",
      description:
        "把状态改回某个还原点记录的样子。别名类还原是真正的原样复位；消息类还原是把" +
        "消息原文重新投递回原队列，如果这些消息在此期间已被正常处理，还原会导致重复处理。",
      inputSchema: {
        restorePointId: z.string().describe("还原点 ID，从 list_restore_points 获取"),
        dryRun: dryRunField,
      },
      annotations: mutating,
    },
    async ({ restorePointId, dryRun }) =>
      guard(async () => {
        const result = await restore(restorePointId, dryRun);
        return ok(result.summary, result);
      }),
  );

  return server;
};
