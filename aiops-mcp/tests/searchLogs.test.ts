import { beforeEach, describe, expect, it, vi } from "vitest";
import { logGroupFromLogField } from "../src/tools/insights.js";

const { runInsightsQuery, listLogGroups } = vi.hoisted(() => ({
  runInsightsQuery: vi.fn(),
  listLogGroups: vi.fn(),
}));

vi.mock("../src/tools/insights.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/tools/insights.js")>()),
  runInsightsQuery,
}));
vi.mock("../src/tools/logGroups.js", () => ({ listLogGroups }));

import { searchLogs } from "../src/tools/searchLogs.js";

const ALL_GROUPS = [
  "/aws/lambda/zuoye-collector-CollectorFunction",
  "/aws/lambda/zuoye-perf-ingest-IngestFunction",
  "/ecs/zuoye-perf-cleaner",
  "/perf/raw",
];

const row = (group: string, message: string, timestamp = "2026-08-06 00:00:00.000") => ({
  "@timestamp": timestamp,
  "@message": message,
  "@log": `089783390738:${group}`,
});

describe("searchLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listLogGroups.mockResolvedValue({ groups: ALL_GROUPS.map((name) => ({ name })), summary: "" });
    runInsightsQuery.mockResolvedValue([]);
  });

  // 这是这个工具存在的理由：不指定就查全部，新组件不用改代码就能被查到。
  it("不指定日志组时查全部", async () => {
    await searchLogs({});
    expect(runInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ logGroupNames: ALL_GROUPS }),
    );
  });

  it("指定日志组时只查指定的那些", async () => {
    await searchLogs({ logGroups: ["/perf/raw"] });
    expect(runInsightsQuery).toHaveBeenCalledWith(
      expect.objectContaining({ logGroupNames: ["/perf/raw"] }),
    );
    expect(listLogGroups).not.toHaveBeenCalled();
  });

  it("标明每条记录来自哪个日志组", async () => {
    runInsightsQuery.mockResolvedValue([
      row("/perf/raw", '{"site":"zuoye-frontend"}'),
      row("/ecs/zuoye-perf-cleaner", "清洗完成: 扫描 5"),
    ]);

    const result = await searchLogs({});

    expect(result.entries.map((e) => e.logGroup)).toEqual([
      "/perf/raw",
      "/ecs/zuoye-perf-cleaner",
    ]);
  });

  // 排查时经常要先确认"到底有没有东西在写"，而不是先假设错误长什么样。
  it("pattern 留空时不加过滤条件", async () => {
    await searchLogs({});
    const query = runInsightsQuery.mock.calls[0]?.[0].queryString as string;
    expect(query).not.toContain("filter");
  });

  it("给了 pattern 才过滤", async () => {
    await searchLogs({ pattern: "sslmode" });
    const query = runInsightsQuery.mock.calls[0]?.[0].queryString as string;
    expect(query).toContain("filter @message like /sslmode/");
  });

  // 被丢掉的日志组恰恰可能是问题所在，Agent 必须知道自己没看全。
  it("日志组超过 Insights 上限时截断并明确告知", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `/group/${i}` }));
    listLogGroups.mockResolvedValue({ groups: many, summary: "" });

    const result = await searchLogs({});

    expect(result.logGroups).toHaveLength(50);
    expect(result.truncatedGroups).toBe(true);
    expect(result.summary).toContain("只查了前 50 个");
  });

  it("日志组数量正常时不标截断", async () => {
    const result = await searchLogs({});
    expect(result.truncatedGroups).toBe(false);
    expect(result.summary).not.toContain("只查了前");
  });

  it("没有任何日志组时直接返回空而不查询", async () => {
    listLogGroups.mockResolvedValue({ groups: [], summary: "" });

    const result = await searchLogs({});

    expect(result.entries).toHaveLength(0);
    expect(runInsightsQuery).not.toHaveBeenCalled();
  });

  it("limit 收敛到 100 以内", async () => {
    await searchLogs({ limit: 9999 });
    expect(runInsightsQuery).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }));
  });

  // 日志内容可能带密钥，返回前必须过脱敏。
  it("消息经过脱敏与截断", async () => {
    runInsightsQuery.mockResolvedValue([
      row("/perf/raw", `Bearer ${"a".repeat(40)} ${"x".repeat(900)}`),
    ]);

    const result = await searchLogs({});
    const message = result.entries[0]?.message ?? "";

    expect(message).not.toContain("aaaaaaaaaaaaaaaaaaaa");
    expect(message).toContain("(已截断)");
  });
});

describe("logGroupFromLogField", () => {
  it("从 账号ID:日志组名 里取出日志组名", () => {
    expect(logGroupFromLogField("089783390738:/perf/raw")).toBe("/perf/raw");
  });

  it("日志组名本身含冒号时只按第一个冒号切", () => {
    expect(logGroupFromLogField("089783390738:/a/b:c")).toBe("/a/b:c");
  });

  it("没有冒号时原样返回", () => {
    expect(logGroupFromLogField("/perf/raw")).toBe("/perf/raw");
  });
});
