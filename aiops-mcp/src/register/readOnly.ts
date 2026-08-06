import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { topology } from "../config.js";
import { guard, ok } from "../toolResult.js";
import { alarmTimeline } from "../tools/alarmTimeline.js";
import { checkReady } from "../tools/checkReady.js";
import { deploymentState } from "../tools/deploymentState.js";
import { diagnose } from "../tools/diagnose.js";
import { queueDepth } from "../tools/dlqDepth.js";
import { listAlarms } from "../tools/listAlarms.js";
import { getMetrics } from "../tools/metrics.js";
import { listLogGroups } from "../tools/logGroups.js";
import { listRestorePoints } from "../tools/restoreTool.js";
import { searchLogs } from "../tools/searchLogs.js";
import { tailLogs } from "../tools/tailLogs.js";
import { readOnly } from "./shared.js";

/**
 * 装配只读工具与拓扑资源。
 *
 * 这些工具重复调用多少次都不会改变线上状态，因此远程入口只装配它们——
 * 公网端点靠一个 token 保护，能力上限必须止于"看"。
 */
export const registerReadOnlyTools = (server: McpServer): void => {
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
    "list_log_groups",
    {
      title: "列出账号里的日志组",
      description:
        "返回全部日志组及其保留期与占用大小。tail_logs 只覆盖三个核心组件，" +
        "这里能看到系统里实际存在的所有日志来源——包括后来长出来的新组件。" +
        "配合 search_logs 用：先看有什么，再决定查哪个。",
      inputSchema: {
        prefix: z
          .string()
          .optional()
          .describe("按前缀过滤，例如 /perf 或 /aws/lambda/zuoye-collector"),
      },
      annotations: readOnly,
    },
    async ({ prefix }) =>
      guard(async () => {
        const result = await listLogGroups(prefix);
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "search_logs",
    {
      title: "跨任意日志组查日志",
      description:
        "在指定日志组（留空则全部）里查最近的日志，返回结果标明每条来自哪个组。" +
        "tail_logs 的通用版：不受预设 target 限制，能查到账号里任何日志。" +
        "pattern 留空时不过滤，用来确认某个组件到底有没有在写日志。查询需要几秒。",
      inputSchema: {
        logGroups: z
          .array(z.string())
          .optional()
          .describe("要查的日志组名，留空表示查全部（先用 list_log_groups 看有哪些）"),
        pattern: z
          .string()
          .optional()
          .describe("正则模式，留空则不过滤、返回窗口内最近的记录"),
        minutes: z.number().int().min(1).max(1440).default(30).describe("回溯多少分钟"),
        limit: z.number().int().min(1).max(100).default(20).describe("最多返回几条"),
      },
      annotations: readOnly,
    },
    async ({ logGroups, pattern, minutes, limit }) =>
      guard(async () => {
        const result = await searchLogs({ logGroups, pattern, minutes, limit });
        return ok(result.summary, result);
      }),
  );

  server.registerTool(
    "diagnose",
    {
      title: "跑一轮完整诊断",
      description:
        "一次调用完成整套排查：找出正在触发的告警、定位故障起点、比对最近的发布时间、" +
        "按告警类型收集对应证据（队列样本或错误日志）、检查链路当前是否通、看指标趋势。" +
        "返回结构化证据包和已经算好的时间关联。" +
        "怀疑系统有问题时先调这个，它比逐个调工具更完整，也不会漏掉步骤。" +
        "注意它只摆事实和关联，最终判断由你来下。",
      inputSchema: {
        minutes: z
          .number()
          .int()
          .min(5)
          .max(1440)
          .default(60)
          .describe("日志与指标的回溯窗口，分钟"),
      },
      annotations: readOnly,
    },
    async ({ minutes }) =>
      guard(async () => {
        const result = await diagnose(minutes);
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

};
