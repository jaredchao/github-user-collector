import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "../aws.js";
import { restoreStore } from "../restore/store.js";
import type { AliasPayload, MessagesPayload, RestorePoint } from "../restore/types.js";
import { applyAlias } from "./aliasControl.js";
import { dryRunResult, executedResult, type WriteResult } from "./writeResult.js";

export type RestorePointSummary = Readonly<{
  id: string;
  createdAt: string;
  operation: string;
  target: string;
  description: string;
  restoredAt: string | null;
}>;

export type ListRestorePointsResult = Readonly<{
  points: readonly RestorePointSummary[];
  summary: string;
}>;

/** 列出可用的还原点，最近的在前。 */
export const listRestorePoints = async (limit = 20): Promise<ListRestorePointsResult> => {
  const points = await restoreStore().list(limit);
  const summaries = points.map((point) => ({
    id: point.id,
    createdAt: point.createdAt,
    operation: point.operation,
    target: point.target,
    description: point.description,
    restoredAt: point.restoredAt ?? null,
  }));

  return {
    points: Object.freeze(summaries),
    summary:
      summaries.length === 0
        ? "还没有任何还原点——说明尚未执行过写操作"
        : `共 ${summaries.length} 个还原点，最近一个是 ${summaries[0]?.id}` +
          `（${summaries[0]?.description}）`,
  };
};

const restoreAlias = async (payload: AliasPayload, dryRun: boolean): Promise<string> => {
  const plan =
    `把别名 ${payload.aliasName} 改回主版本 ${payload.functionVersion}` +
    (Object.keys(payload.additionalVersionWeights).length > 0
      ? `，并恢复权重 ${JSON.stringify(payload.additionalVersionWeights)}`
      : "，并清空灰度权重");

  if (!dryRun) {
    await applyAlias({
      functionName: payload.functionName,
      aliasName: payload.aliasName,
      functionVersion: payload.functionVersion,
      weights: { ...payload.additionalVersionWeights },
    });
  }
  return plan;
};

const restoreMessages = async (
  payload: MessagesPayload,
  dryRun: boolean,
): Promise<string> => {
  const plan = `把 ${payload.messages.length} 条消息重新投递回 ${payload.sourceQueueUrl}`;

  if (!dryRun) {
    for (const message of payload.messages) {
      await sqs().send(
        new SendMessageCommand({
          QueueUrl: payload.sourceQueueUrl,
          MessageBody: message.body,
        }),
      );
    }
  }
  return plan;
};

const dispatch = (point: RestorePoint, dryRun: boolean): Promise<string> => {
  switch (point.operation) {
    case "set_alias_weight":
    case "rollback_canary":
      return restoreAlias(point.payload as AliasPayload, dryRun);
    case "redrive_dlq":
    case "discard_dlq_messages":
      return restoreMessages(point.payload as MessagesPayload, dryRun);
    default:
      throw new Error(`不认识的还原点类型: ${String(point.operation)}`);
  }
};

/**
 * 按还原点把状态改回去。
 *
 * 消息类还原有一处必须讲清楚：它是把消息原文重新投递回原队列，
 * 而不是让时间倒流。如果那些消息在丢弃之后已经被正常处理过，
 * 还原会让它们被再处理一次。别名类还原则是真正的原样复位。
 */
export const restore = async (
  restorePointId: string,
  dryRun = true,
): Promise<WriteResult> => {
  const point = await restoreStore().load(restorePointId);
  if (!point) throw new Error(`还原点 ${restorePointId} 不存在`);

  const plan = await dispatch(point, true);

  if (dryRun) {
    return dryRunResult(plan, {
      restorePoint: {
        id: point.id,
        createdAt: point.createdAt,
        operation: point.operation,
        description: point.description,
        restoredAt: point.restoredAt ?? null,
      },
      warning:
        point.restoredAt !== undefined
          ? `这个还原点已经在 ${point.restoredAt} 还原过一次，再次还原可能造成重复`
          : undefined,
    });
  }

  await dispatch(point, false);
  const at = new Date().toISOString();
  await restoreStore().markRestored(point.id, at);

  return executedResult({
    plan,
    restorePointId: point.id,
    summary: `已按还原点 ${point.id} 还原：${plan}`,
    details: { restoredAt: at },
  });
};
