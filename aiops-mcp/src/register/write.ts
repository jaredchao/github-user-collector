import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { guard, ok } from "../toolResult.js";
import { rollbackCanary, setAliasWeight } from "../tools/aliasControl.js";
import { discardDlqMessages, redriveDlq } from "../tools/dlqControl.js";
import { restore } from "../tools/restoreTool.js";
import { dryRunField, mutating } from "./shared.js";

/**
 * 装配写工具。
 *
 * 只有本地 stdio 入口会调用它。远程入口连 import 都不写——读写分离在这里
 * 是结构性的：要让公网端点具备写能力，必须先加一行 import，而那一行在
 * code review 里藏不住。
 */
export const registerWriteTools = (server: McpServer): void => {
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

};
