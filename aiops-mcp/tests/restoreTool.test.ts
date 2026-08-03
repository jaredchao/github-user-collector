import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RestorePoint } from "../src/restore/types.js";
import { MemoryRestoreStore } from "./memoryStore.js";

const lambdaSend = vi.fn();
const sqsSend = vi.fn();

vi.mock("../src/aws.js", () => ({
  lambda: () => ({ send: lambdaSend }),
  sqs: () => ({ send: sqsSend }),
}));
vi.mock("../src/config.js", () => ({
  topology: async () => ({ functionName: "collector-fn" }),
}));

const { restore, listRestorePoints } = await import("../src/tools/restoreTool.js");
const { setRestoreStore } = await import("../src/restore/store.js");

let store: MemoryRestoreStore;

const aliasPoint = (overrides: Partial<RestorePoint> = {}): RestorePoint => ({
  id: "rp-alias-1",
  createdAt: "2026-08-03T00:00:00.000Z",
  operation: "rollback_canary",
  target: "collector-fn:live",
  description: "还原为：别名 live 主版本 3，另有 版本 4 占 10%",
  payload: {
    functionName: "collector-fn",
    aliasName: "live",
    functionVersion: "3",
    additionalVersionWeights: { "4": 0.1 },
  },
  ...overrides,
});

const messagePoint = (): RestorePoint => ({
  id: "rp-msg-1",
  createdAt: "2026-08-03T00:00:00.000Z",
  operation: "discard_dlq_messages",
  target: "https://sqs.test/dlq",
  description: "1 条被丢弃的死信消息原文",
  payload: {
    sourceQueueUrl: "https://sqs.test/dlq",
    messages: [
      { messageId: "m-1", body: "not-a-json-event", receiveCount: 11, sentAt: null },
    ],
  },
});

describe("restore", () => {
  beforeEach(() => {
    lambdaSend.mockReset();
    sqsSend.mockReset();
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("别名还原把版本和权重原样写回去", async () => {
    await store.save(aliasPoint());
    lambdaSend.mockResolvedValue({});

    const result = await restore("rp-alias-1", false);

    expect(result.executed).toBe(true);
    const input = (lambdaSend.mock.calls[0]![0] as { input: Record<string, unknown> })
      .input;
    expect(input).toMatchObject({
      FunctionName: "collector-fn",
      Name: "live",
      FunctionVersion: "3",
      RoutingConfig: { AdditionalVersionWeights: { "4": 0.1 } },
    });
  });

  it("消息还原把原文重新投递回原队列", async () => {
    await store.save(messagePoint());
    sqsSend.mockResolvedValue({});

    await restore("rp-msg-1", false);

    const input = (sqsSend.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input).toMatchObject({
      QueueUrl: "https://sqs.test/dlq",
      MessageBody: "not-a-json-event",
    });
  });

  it("演练时算出计划却不动任何东西", async () => {
    await store.save(aliasPoint());

    const result = await restore("rp-alias-1", true);

    expect(result.dryRun).toBe(true);
    expect(result.plan).toContain("改回主版本 3");
    expect(lambdaSend).not.toHaveBeenCalled();
  });

  it("还原后打上标记，重复还原时给出警告", async () => {
    await store.save(aliasPoint());
    lambdaSend.mockResolvedValue({});

    await restore("rp-alias-1", false);
    expect(store.saved[0]?.restoredAt).toBeTruthy();

    const second = await restore("rp-alias-1", true);
    expect(second.details).toMatchObject({ warning: expect.stringContaining("已经在") });
  });

  it("还原点不存在时明确报错，而不是静默成功", async () => {
    await expect(restore("rp-nope", false)).rejects.toThrow("不存在");
  });
});

describe("listRestorePoints", () => {
  beforeEach(() => {
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("没有还原点时说清楚原因", async () => {
    const result = await listRestorePoints(10);

    expect(result.points).toHaveLength(0);
    expect(result.summary).toContain("尚未执行过写操作");
  });

  it("最近的还原点排在最前", async () => {
    await store.save(aliasPoint({ id: "rp-old" }));
    await store.save(aliasPoint({ id: "rp-new" }));

    const result = await listRestorePoints(10);

    expect(result.points[0]?.id).toBe("rp-new");
    expect(result.summary).toContain("rp-new");
  });
});
