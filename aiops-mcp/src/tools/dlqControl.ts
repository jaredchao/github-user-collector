import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
} from "@aws-sdk/client-sqs";
import { sqs } from "../aws.js";
import { topology } from "../config.js";
import { redact } from "../redact.js";
import { createRestorePoint } from "../restore/store.js";
import type { MessagesPayload } from "../restore/types.js";
import { triageMessage } from "./messageTriage.js";
import { dryRunResult, executedResult, type WriteResult } from "./writeResult.js";

/** 真正处置时把消息藏起来，避免处理到一半被别人取走。 */
const WORK_VISIBILITY_SECONDS = 120;

/**
 * 演练时读完立刻放回。
 *
 * 演练必须没有副作用。用长可见性超时去演练，会让消息在接下来两分钟里
 * 从队列上消失——而 Agent 的典型路径恰恰是"先演练 redrive，看到建议后
 * 立刻演练 discard"，第二步就会看到空队列，进而误报问题已解决。
 */
const PEEK_VISIBILITY_SECONDS = 0;

type DrainedMessage = Readonly<{
  messageId: string;
  receiptHandle: string;
  body: string;
  receiveCount: number;
  sentAt: string | null;
}>;

const drain = async (
  queueUrl: string,
  max: number,
  visibilitySeconds: number,
): Promise<DrainedMessage[]> => {
  const collected = new Map<string, DrainedMessage>();

  while (collected.size < max) {
    const received = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(10, max - collected.size),
        VisibilityTimeout: visibilitySeconds,
        WaitTimeSeconds: 2,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"],
      }),
    );

    const batch = received.Messages ?? [];
    if (batch.length === 0) break;

    // 零可见性超时下消息读完立刻重新可见，同一条会被反复取到。
    // 只靠"批次为空"退出的话，演练会陷入死循环。
    const sizeBefore = collected.size;

    for (const message of batch) {
      const messageId = message.MessageId;
      if (!messageId || collected.has(messageId)) continue;
      const sentTimestamp = message.Attributes?.SentTimestamp;
      collected.set(messageId, {
        messageId,
        receiptHandle: message.ReceiptHandle ?? "",
        body: message.Body ?? "",
        receiveCount: Number(message.Attributes?.ApproximateReceiveCount ?? "0"),
        sentAt: sentTimestamp ? new Date(Number(sentTimestamp)).toISOString() : null,
      });
    }

    if (collected.size === sizeBefore) break;
  }

  return [...collected.values()];
};

/**
 * 还原点里存的是**原文**，不脱敏。
 *
 * 脱敏只作用于给 Agent 看的那份预览。备份存脱敏后的内容等于备份了一份
 * 假数据——还原时投递回去的会是 [REDACTED]，那还不如不备份。
 */
const toPayload = (queueUrl: string, messages: DrainedMessage[]): MessagesPayload => ({
  sourceQueueUrl: queueUrl,
  messages: messages.map(({ messageId, body, receiveCount, sentAt }) => ({
    messageId,
    body,
    receiveCount,
    sentAt,
  })),
});

/**
 * 把死信消息重放回主队列。
 *
 * 顺序是有讲究的：备份 -> 投回主队列 -> 从死信队列删除。
 *
 * 万一投递成功而删除失败，结果是消息重复处理一次——worker 生成介绍
 * 是幂等的，重复无害。反过来先删再投，中间出错就是消息永久丢失。
 * 在不可能两全的地方，选可恢复的那一侧。
 */
export const redriveDlq = async (
  maxMessages = 10,
  dryRun = true,
  force = false,
): Promise<WriteResult> => {
  const topo = await topology();
  const messages = await drain(
    topo.deadLetterQueueUrl,
    maxMessages,
    dryRun ? PEEK_VISIBILITY_SECONDS : WORK_VISIBILITY_SECONDS,
  );

  if (messages.length === 0) {
    return dryRunResult("死信队列里没有消息，无事可做");
  }

  const triaged = messages.map((message) => ({
    ...message,
    triage: triageMessage(message.body),
  }));
  const replayable = triaged.filter((m) => m.triage.replayable);
  const poison = triaged.filter((m) => !m.triage.replayable);

  const inventory = {
    total: triaged.length,
    replayable: replayable.length,
    poison: poison.map((m) => ({
      messageId: m.messageId,
      reason: m.triage.reason,
      bodyPreview: redact(m.body).slice(0, 200),
    })),
  };

  if (poison.length > 0 && !force) {
    const plan =
      `${triaged.length} 条消息里有 ${poison.length} 条格式非法，重放必然再次失败。` +
      `建议对它们用 discard_dlq_messages 归档后丢弃` +
      (replayable.length > 0
        ? `；另外 ${replayable.length} 条可以重放，带 force=true 可只重放这些`
        : "");
    return dryRunResult(plan, inventory);
  }

  const targets = force ? replayable : triaged;
  if (targets.length === 0) {
    return dryRunResult("没有可重放的消息——队列里全是格式非法的毒丸消息", inventory);
  }

  const plan = `把 ${targets.length} 条死信消息重放回主队列`;
  if (dryRun) return dryRunResult(plan, inventory);

  const point = await createRestorePoint({
    operation: "redrive_dlq",
    target: topo.deadLetterQueueUrl,
    description: `${targets.length} 条被重放的死信消息原文，可重新投递回死信队列`,
    payload: toPayload(topo.deadLetterQueueUrl, targets),
  });

  const redriven: string[] = [];
  const failed: { messageId: string; error: string }[] = [];

  for (const message of targets) {
    try {
      await sqs().send(
        new SendMessageCommand({
          QueueUrl: topo.introductionQueueUrl,
          MessageBody: message.body,
        }),
      );
      await sqs().send(
        new DeleteMessageCommand({
          QueueUrl: topo.deadLetterQueueUrl,
          ReceiptHandle: message.receiptHandle,
        }),
      );
      redriven.push(message.messageId);
    } catch (error) {
      failed.push({
        messageId: message.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return executedResult({
    plan,
    restorePointId: point.id,
    summary:
      `已重放 ${redriven.length} 条消息回主队列` +
      (failed.length > 0 ? `，${failed.length} 条失败（原文仍在还原点里）` : "") +
      (poison.length > 0 && force ? `，跳过 ${poison.length} 条毒丸消息` : ""),
    details: { redriven, failed, inventory },
  });
};

/**
 * 归档后丢弃死信消息。
 *
 * 毒丸消息的正确归宿。丢弃之前消息原文一定会先落进还原点——
 * 这是整套设计里最不能省的一次备份，因为删除是唯一真正不可逆的操作。
 */
export const discardDlqMessages = async (
  maxMessages = 10,
  dryRun = true,
): Promise<WriteResult> => {
  const topo = await topology();
  const messages = await drain(
    topo.deadLetterQueueUrl,
    maxMessages,
    dryRun ? PEEK_VISIBILITY_SECONDS : WORK_VISIBILITY_SECONDS,
  );

  if (messages.length === 0) {
    return dryRunResult("死信队列里没有消息，无事可做");
  }

  const inventory = messages.map((message) => ({
    messageId: message.messageId,
    receiveCount: message.receiveCount,
    sentAt: message.sentAt,
    triage: triageMessage(message.body).reason,
    bodyPreview: redact(message.body).slice(0, 200),
  }));

  const plan = `把 ${messages.length} 条死信消息归档后从队列删除`;
  if (dryRun) return dryRunResult(plan, inventory);

  const point = await createRestorePoint({
    operation: "discard_dlq_messages",
    target: topo.deadLetterQueueUrl,
    description: `${messages.length} 条被丢弃的死信消息原文，可重新投递回死信队列`,
    payload: toPayload(topo.deadLetterQueueUrl, messages),
  });

  const discarded: string[] = [];
  const failed: { messageId: string; error: string }[] = [];

  for (const message of messages) {
    try {
      await sqs().send(
        new DeleteMessageCommand({
          QueueUrl: topo.deadLetterQueueUrl,
          ReceiptHandle: message.receiptHandle,
        }),
      );
      discarded.push(message.messageId);
    } catch (error) {
      failed.push({
        messageId: message.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return executedResult({
    plan,
    restorePointId: point.id,
    summary:
      `已归档并删除 ${discarded.length} 条死信消息` +
      (failed.length > 0 ? `，${failed.length} 条删除失败` : "") +
      `。原文全部保存在还原点 ${point.id}`,
    details: { discarded, failed, inventory },
  });
};
