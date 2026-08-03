import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("../src/aws.js", () => ({ sqs: () => ({ send }) }));
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
  beforeEach(() => send.mockReset());

  it("空队列时说清楚是空的", async () => {
    send.mockResolvedValueOnce(attributesReply("0"));
    const result = await queueDepth("dead-letter");

    expect(result.visible).toBe(0);
    expect(result.summary).toBe("死信队列是空的");
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
