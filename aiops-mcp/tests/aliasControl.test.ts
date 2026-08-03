import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRestoreStore } from "./memoryStore.js";

const send = vi.fn();

vi.mock("../src/aws.js", () => ({ lambda: () => ({ send }) }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({ functionName: "collector-fn" }),
}));

const { setAliasWeight, rollbackCanary } = await import("../src/tools/aliasControl.js");
const { setRestoreStore } = await import("../src/restore/store.js");

let store: MemoryRestoreStore;

const commandName = (index: number): string =>
  (send.mock.calls[index]![0] as object).constructor.name;

const inputOf = (index: number): Record<string, unknown> =>
  (send.mock.calls[index]![0] as { input: Record<string, unknown> }).input;

const aliasReply = (version: string, weights: Record<string, number> = {}) => ({
  FunctionVersion: version,
  RoutingConfig: Object.keys(weights).length > 0
    ? { AdditionalVersionWeights: weights }
    : undefined,
});

describe("setAliasWeight", () => {
  beforeEach(() => {
    send.mockReset();
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("演练时读了别名却绝不改动它", async () => {
    send.mockResolvedValueOnce(aliasReply("3"));

    const result = await setAliasWeight("4", 0.1, true);

    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.summary).toContain("未实际执行");
    // 只发生了一次读取，没有任何 UpdateAlias
    expect(send).toHaveBeenCalledTimes(1);
    expect(commandName(0)).toBe("GetAliasCommand");
    expect(store.saved).toHaveLength(0);
  });

  it("真正执行时，还原点必须先于变更写入", async () => {
    send.mockResolvedValueOnce(aliasReply("3"));
    send.mockResolvedValueOnce({});

    const result = await setAliasWeight("4", 0.1, false);

    expect(result.executed).toBe(true);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]?.payload).toMatchObject({
      functionVersion: "3",
      additionalVersionWeights: {},
    });
    expect(commandName(1)).toBe("UpdateAliasCommand");
    expect(inputOf(1)).toMatchObject({
      FunctionVersion: "3",
      RoutingConfig: { AdditionalVersionWeights: { "4": 0.1 } },
    });
    expect(result.undoHint).toContain(store.saved[0]!.id);
  });

  it("备份失败就整个操作失败，绝不做无法撤销的改动", async () => {
    send.mockResolvedValueOnce(aliasReply("3"));
    setRestoreStore({
      save: async () => {
        throw new Error("磁盘满了");
      },
      load: async () => null,
      list: async () => [],
      markRestored: async () => {},
    });

    await expect(setAliasWeight("4", 0.1, false)).rejects.toThrow("磁盘满了");
    // 关键：没有任何 UpdateAlias 被发出
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("拒绝越界的权重", async () => {
    await expect(setAliasWeight("4", 0, false)).rejects.toThrow("权重必须在");
    await expect(setAliasWeight("4", 1, false)).rejects.toThrow("权重必须在");
    expect(send).not.toHaveBeenCalled();
  });

  it("拒绝给已经是主版本的版本加权重", async () => {
    send.mockResolvedValueOnce(aliasReply("3"));

    await expect(setAliasWeight("3", 0.1, false)).rejects.toThrow("已经是");
  });
});

describe("rollbackCanary", () => {
  beforeEach(() => {
    send.mockReset();
    store = new MemoryRestoreStore();
    setRestoreStore(store);
  });

  it("摘掉候选版本时清空权重表", async () => {
    send.mockResolvedValueOnce(aliasReply("3", { "4": 0.1 }));
    send.mockResolvedValueOnce({});

    const result = await rollbackCanary(undefined, false);

    expect(inputOf(1)).toMatchObject({
      FunctionVersion: "3",
      RoutingConfig: { AdditionalVersionWeights: {} },
    });
    expect(result.summary).toContain("100% 流量收回版本 3");
    // 还原点里留着回滚前的权重，撤销时能把灰度恢复原样
    expect(store.saved[0]?.payload).toMatchObject({
      additionalVersionWeights: { "4": 0.1 },
    });
  });

  it("传了目标版本时连主版本一起切", async () => {
    send.mockResolvedValueOnce(aliasReply("5"));
    send.mockResolvedValueOnce({});

    await rollbackCanary("3", false);

    expect(inputOf(1)).toMatchObject({ FunctionVersion: "3" });
  });

  it("没有灰度也没指定目标版本时拒绝执行，而不是假装成功", async () => {
    send.mockResolvedValueOnce(aliasReply("3"));

    await expect(rollbackCanary(undefined, false)).rejects.toThrow("没有可回滚的内容");
    expect(store.saved).toHaveLength(0);
  });
});
