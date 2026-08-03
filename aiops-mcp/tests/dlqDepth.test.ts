import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const queueOldestMessageAge = vi.fn(async () => null);

vi.mock("../src/aws.js", () => ({ sqs: () => ({ send }) }));
vi.mock("../src/tools/metrics.js", () => ({ queueOldestMessageAge }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({
    deadLetterQueueUrl: "https://sqs.test/dlq",
    introductionQueueUrl: "https://sqs.test/main",
  }),
}));

const { queueDepth } = await import("../src/tools/dlqDepth.js");

const attributesReply = (visible: string, inFlight = "0") => ({
  Attributes: {
    ApproximateNumberOfMessages: visible,
    ApproximateNumberOfMessagesNotVisible: inFlight,
  },
});

const commandName = (call: unknown[]): string =>
  (call[0] as object).constructor.name;

describe("queueDepth", () => {
  beforeEach(() => {
    send.mockReset();
    queueOldestMessageAge.mockClear();
  });

  it("空队列时说清楚是空的", async () => {
    send.mockResolvedValueOnce(attributesReply("0"));
    const result = await queueDepth("dead-letter");

    expect(result.visible).toBe(0);
    expect(result.summary).toBe("死信队列是空的");
    // 队列是空的就没必要再问 CloudWatch 最老消息年龄
    expect(queueOldestMessageAge).not.toHaveBeenCalled();
  });

  it("没有样本时只能报可见时长，并说明它不等于入队时长", async () => {
    send.mockResolvedValueOnce(attributesReply("3"));
    queueOldestMessageAge.mockResolvedValueOnce(1892 as never);

    const result = await queueDepth("dead-letter");

    expect(queueOldestMessageAge).toHaveBeenCalledWith("https://sqs.test/dlq");
    expect(result.visibleAgeSeconds).toBe(1892);
    expect(result.oldestEnqueuedAgeSeconds).toBeNull();
    expect(result.summary).toContain("已可见 31 分钟");
    expect(result.summary).toContain("这不等于它入队多久");
  });

  it("有样本时用 SentTimestamp 算真实滞留时长，盖过被重置的可见时长", async () => {
    const threeDaysAgo = Date.now() - 65 * 3600 * 1000;
    send.mockResolvedValueOnce(attributesReply("1"));
    send.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "m-1",
          Body: "not-a-json-event",
          Attributes: {
            ApproximateReceiveCount: "11",
            SentTimestamp: String(threeDaysAgo),
          },
        },
      ],
    });
    // CloudWatch 说才 31 分钟——因为诊断时的偷看把它重置了
    queueOldestMessageAge.mockResolvedValueOnce(1892 as never);

    const result = await queueDepth("dead-letter", 3);

    expect(result.visibleAgeSeconds).toBe(1892);
    expect(result.oldestEnqueuedAgeSeconds).toBeGreaterThanOrEqual(65 * 3600);
    // 报的是真相，不是被自己的诊断动作洗过的那个数
    expect(result.summary).toContain("已入队 65 小时");
  });

  it("两个来源都取不到时不编造年龄", async () => {
    send.mockResolvedValueOnce(attributesReply("3"));
    queueOldestMessageAge.mockResolvedValueOnce(null);

    const result = await queueDepth("dead-letter");

    expect(result.visibleAgeSeconds).toBeNull();
    expect(result.oldestEnqueuedAgeSeconds).toBeNull();
    expect(result.summary).toBe("死信队列积压 3 条可见消息");
  });

  it("不要样本时绝不去碰消息", async () => {
    send.mockResolvedValueOnce(attributesReply("5"));
    await queueDepth("dead-letter", 0);

    // 只发了一次 GetQueueAttributes，没有任何 ReceiveMessage
    expect(send).toHaveBeenCalledTimes(1);
    expect(commandName(send.mock.calls[0]!)).toBe("GetQueueAttributesCommand");
  });

  it("偷看消息时必须用零可见性超时，否则会把消息藏起来", async () => {
    send.mockResolvedValueOnce(attributesReply("2"));
    send.mockResolvedValueOnce({
      Messages: [
        {
          MessageId: "m-1",
          Body: '{"username":"torvalds"}',
          Attributes: { ApproximateReceiveCount: "6", SentTimestamp: "1000000000000" },
        },
      ],
    });

    const result = await queueDepth("dead-letter", 3);
    const receiveCall = send.mock.calls[1]![0] as { input: Record<string, unknown> };

    expect(commandName(send.mock.calls[1]!)).toBe("ReceiveMessageCommand");
    expect(receiveCall.input.VisibilityTimeout).toBe(0);
    expect(result.sample[0]?.receiveCount).toBe(6);
    expect(result.sample[0]?.messageId).toBe("m-1");
  });

  it("队列积压为零时不去偷看，省掉一次无谓调用", async () => {
    send.mockResolvedValueOnce(attributesReply("0"));
    await queueDepth("dead-letter", 5);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("按参数选中主队列", async () => {
    send.mockResolvedValueOnce(attributesReply("0"));
    const result = await queueDepth("main");

    expect(result.queueUrl).toBe("https://sqs.test/main");
    expect(result.summary).toContain("主队列");
  });
});
