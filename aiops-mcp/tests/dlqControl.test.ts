import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRestoreStore } from "./memoryStore.js";

const send = vi.fn();

vi.mock("../src/aws.js", () => ({ sqs: () => ({ send }) }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({
    deadLetterQueueUrl: "https://sqs.test/dlq",
    introductionQueueUrl: "https://sqs.test/main",
  }),
}));

const { redriveDlq, discardDlqMessages } = await import("../src/tools/dlqControl.js");
const { setRestoreStore } = await import("../src/restore/store.js");

let store: MemoryRestoreStore;

const commandNames = (): string[] =>
  send.mock.calls.map((call) => (call[0] as object).constructor.name);

const inputOf = (index: number): Record<string, unknown> =>
  (send.mock.calls[index]![0] as { input: Record<string, unknown> }).input;

const goodBody = JSON.stringify({
  eventType: "profile.saved",
  eventId: "evt-1",
  username: "torvalds",
  profileId: 42,
});

const message = (id: string, body: string) => ({
  MessageId: id,
  ReceiptHandle: `rh-${id}`,
  Body: body,
  Attributes: { ApproximateReceiveCount: "5", SentTimestamp: "1000000000000" },
});

/** drain 会一直取到空批次为止，所以每个用例都要给一个收尾的空回复。 */
const drainReplies = (...messages: object[]) => {
  send.mockResolvedValueOnce({ Messages: messages });
  send.mockResolvedValueOnce({ Messages: [] });
};

describe("redriveDlq", () => {
  beforeEach(() => {
    send.mockReset();
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("队列里全是毒丸消息时拒绝重放，并指路到 discard", async () => {
    drainReplies(message("m-1", "not-a-json-event"));

    const result = await redriveDlq(10, false);

    expect(result.executed).toBe(false);
    expect(result.plan).toContain("discard_dlq_messages");
    // 一条都没发出去
    expect(commandNames().filter((n) => n === "SendMessageCommand")).toHaveLength(0);
    expect(store.saved).toHaveLength(0);
  });

  it("混合队列默认整批拒绝，避免悄悄放过毒丸消息", async () => {
    drainReplies(message("m-1", goodBody), message("m-2", "not-a-json-event"));

    const result = await redriveDlq(10, false);

    expect(result.executed).toBe(false);
    expect(result.plan).toContain("force=true");
  });

  it("force 时只重放可重放的，毒丸消息留在原地", async () => {
    drainReplies(message("m-1", goodBody), message("m-2", "not-a-json-event"));
    send.mockResolvedValue({});

    const result = await redriveDlq(10, false, true);

    expect(result.executed).toBe(true);
    expect(result.details).toMatchObject({ redriven: ["m-1"] });
    // 只有那条合法消息被投回主队列
    const sends = send.mock.calls.filter(
      (call) => (call[0] as object).constructor.name === "SendMessageCommand",
    );
    expect(sends).toHaveLength(1);
    expect((sends[0]![0] as { input: Record<string, unknown> }).input).toMatchObject({
      QueueUrl: "https://sqs.test/main",
      MessageBody: goodBody,
    });
  });

  it("先备份，再投递，最后才删除原件", async () => {
    drainReplies(message("m-1", goodBody));
    send.mockResolvedValue({});

    await redriveDlq(10, false);

    // 备份已经落盘
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.payload).toMatchObject({
      sourceQueueUrl: "https://sqs.test/dlq",
      messages: [{ messageId: "m-1", body: goodBody }],
    });

    // 顺序：投主队列在前，删死信在后。反过来出错就是消息永久丢失
    const names = commandNames();
    const sendIndex = names.indexOf("SendMessageCommand");
    const deleteIndex = names.indexOf("DeleteMessageCommand");
    expect(sendIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeGreaterThan(sendIndex);
    expect(inputOf(deleteIndex)).toMatchObject({
      QueueUrl: "https://sqs.test/dlq",
      ReceiptHandle: "rh-m-1",
    });
  });

  it("演练时不投递也不删除", async () => {
    drainReplies(message("m-1", goodBody));

    const result = await redriveDlq(10, true);

    expect(result.dryRun).toBe(true);
    expect(commandNames()).not.toContain("SendMessageCommand");
    expect(commandNames()).not.toContain("DeleteMessageCommand");
    expect(store.saved).toHaveLength(0);
  });

  it("空队列时如实说无事可做", async () => {
    send.mockResolvedValueOnce({ Messages: [] });

    const result = await redriveDlq(10, false);

    expect(result.executed).toBe(false);
    expect(result.plan).toContain("没有消息");
  });

  it("演练用零可见性超时，不把消息从队列上藏走", async () => {
    drainReplies(message("m-1", goodBody));

    await redriveDlq(10, true);

    // 否则接下来两分钟内，后续诊断会看到一个假的空队列
    expect(inputOf(0)).toMatchObject({ VisibilityTimeout: 0 });
  });

  it("真正执行时才把消息藏起来，避免处理到一半被别人取走", async () => {
    drainReplies(message("m-1", goodBody));
    send.mockResolvedValue({});

    await redriveDlq(10, false);

    expect(inputOf(0)).toMatchObject({ VisibilityTimeout: 120 });
  });

  it("零可见性超时下同一条消息被反复取到时不会死循环", async () => {
    // 消息立刻重新可见，SQS 会一直把它返回来
    send.mockResolvedValue({ Messages: [message("m-1", goodBody)] });

    const result = await redriveDlq(10, true);

    expect(result.details).toMatchObject({ total: 1 });
    // 一轮没有新增就退出，不会无限拉取
    expect(send.mock.calls.length).toBeLessThanOrEqual(3);
  });
});

describe("discardDlqMessages", () => {
  beforeEach(() => {
    send.mockReset();
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("删除之前消息原文必须完整落进还原点", async () => {
    drainReplies(message("m-1", "not-a-json-event"));
    send.mockResolvedValue({});

    const result = await discardDlqMessages(10, false);

    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.payload).toMatchObject({
      messages: [{ messageId: "m-1", body: "not-a-json-event" }],
    });

    const names = commandNames();
    expect(names.indexOf("DeleteMessageCommand")).toBeGreaterThan(-1);
    expect(result.summary).toContain(store.saved[0]!.id);
  });

  it("演练时不删除任何东西", async () => {
    drainReplies(message("m-1", "not-a-json-event"));

    const result = await discardDlqMessages(10, true);

    expect(result.dryRun).toBe(true);
    expect(commandNames()).not.toContain("DeleteMessageCommand");
    expect(store.saved).toHaveLength(0);
  });

  it("备份失败就不删除，宁可留着告警也不丢数据", async () => {
    drainReplies(message("m-1", "not-a-json-event"));
    setRestoreStore({
      save: async () => {
        throw new Error("磁盘满了");
      },
      load: async () => null,
      list: async () => [],
      markRestored: async () => {},
    });

    await expect(discardDlqMessages(10, false)).rejects.toThrow("磁盘满了");
    expect(commandNames()).not.toContain("DeleteMessageCommand");
  });
});
