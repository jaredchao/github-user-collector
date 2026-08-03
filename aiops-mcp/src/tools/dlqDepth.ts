import { GetQueueAttributesCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { sqs } from "../aws.js";
import { topology } from "../config.js";

export type PeekedMessage = Readonly<{
  messageId: string;
  body: string;
  /** 这条消息被投递过几次——大于 1 说明它是重试耗尽后掉进来的。 */
  receiveCount: number;
  sentAt: string | null;
}>;

export type QueueDepthResult = Readonly<{
  queue: "dead-letter" | "main";
  queueUrl: string;
  visible: number;
  inFlight: number;
  oldestMessageAgeSeconds: number | null;
  sample: readonly PeekedMessage[];
  summary: string;
}>;

const toInt = (value?: string): number => (value ? Number.parseInt(value, 10) : 0);

/**
 * 看队列积压，并可选地偷看几条消息内容。
 *
 * 偷看用 VisibilityTimeout=0：消息读完立刻对其他消费者重新可见，
 * 不会被这次诊断吞掉。这是只读工具能碰 SQS 的唯一安全姿势——
 * 常规的 ReceiveMessage 会把消息藏起来 30 秒，诊断动作本身就成了故障。
 *
 * 唯一躲不掉的副作用：每次偷看都会让消息的 ApproximateReceiveCount 加一。
 * 这是 SQS 的语义，没有真正的只读读法。死信队列本身没有重投策略，
 * 计数增长不会导致消息被再次转移，但读到的计数值要按"含诊断次数"理解。
 */
export const queueDepth = async (
  which: "dead-letter" | "main" = "dead-letter",
  sampleSize = 0,
): Promise<QueueDepthResult> => {
  const topo = await topology();
  const queueUrl =
    which === "dead-letter" ? topo.deadLetterQueueUrl : topo.introductionQueueUrl;

  const attributes = await sqs().send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        "ApproximateNumberOfMessages",
        "ApproximateNumberOfMessagesNotVisible",
      ],
    }),
  );

  const visible = toInt(attributes.Attributes?.ApproximateNumberOfMessages);
  const inFlight = toInt(attributes.Attributes?.ApproximateNumberOfMessagesNotVisible);

  const sample: PeekedMessage[] = [];
  if (sampleSize > 0 && visible > 0) {
    const received = await sqs().send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: Math.min(sampleSize, 10),
        VisibilityTimeout: 0,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "SentTimestamp"],
      }),
    );
    // 零可见性超时意味着消息读完立刻重新可见，同一次请求里同一条
    // 消息可能被取到多次。不去重的话 Agent 会把 1 条毒丸消息看成 3 条积压。
    const seen = new Set<string>();
    for (const message of received.Messages ?? []) {
      const messageId = message.MessageId ?? "";
      if (seen.has(messageId)) continue;
      seen.add(messageId);

      const sentTimestamp = message.Attributes?.SentTimestamp;
      sample.push({
        messageId,
        body: message.Body ?? "",
        receiveCount: toInt(message.Attributes?.ApproximateReceiveCount),
        sentAt: sentTimestamp ? new Date(Number(sentTimestamp)).toISOString() : null,
      });
    }
  }

  const oldest = sample.reduce<number | null>((acc, message) => {
    if (!message.sentAt) return acc;
    const age = Math.floor((Date.now() - Date.parse(message.sentAt)) / 1000);
    return acc === null || age > acc ? age : acc;
  }, null);

  const label = which === "dead-letter" ? "死信队列" : "主队列";
  const summary =
    visible === 0 && inFlight === 0
      ? `${label}是空的`
      : `${label}积压 ${visible} 条可见消息` +
        (inFlight > 0 ? `，另有 ${inFlight} 条处理中` : "") +
        (oldest !== null ? `，样本中最老一条已滞留 ${Math.floor(oldest / 3600)} 小时` : "");

  return {
    queue: which,
    queueUrl,
    visible,
    inFlight,
    oldestMessageAgeSeconds: oldest,
    sample: Object.freeze(sample),
    summary,
  };
};
