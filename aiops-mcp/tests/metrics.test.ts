import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiIdOf, periodFor, queueNameOf } from "../src/tools/metricQueries.js";

const send = vi.fn();

vi.mock("../src/aws.js", () => ({ cloudwatch: () => ({ send }) }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({
    functionName: "collector-fn",
    workerFunctionName: "worker-fn",
    apiUrl: "https://kp6eccqn9h.execute-api.us-east-2.amazonaws.com",
    introductionQueueUrl: "https://sqs.test/main-queue",
    deadLetterQueueUrl: "https://sqs.test/dlq-queue",
  }),
}));

const { getMetrics, queueOldestMessageAge } = await import("../src/tools/metrics.js");

/** CloudWatch 默认按时间倒序返回，第一个是最新的。 */
const reply = (values: number[]) => ({
  MetricDataResults: [{ Id: "collector_errors", Values: values }],
});

describe("metricQueries 的纯函数", () => {
  it("从 API 地址里取出 API ID", () => {
    expect(apiIdOf("https://kp6eccqn9h.execute-api.us-east-2.amazonaws.com")).toBe(
      "kp6eccqn9h",
    );
  });

  it("地址不合法时返回空串而不是抛错", () => {
    expect(apiIdOf("not a url")).toBe("");
  });

  it("队列名取地址最后一段", () => {
    expect(queueNameOf("https://sqs.us-east-2.amazonaws.com/089783390738/my-dlq")).toBe(
      "my-dlq",
    );
  });

  it("采样周期落在 CloudWatch 允许的范围内且是 60 的倍数", () => {
    for (const minutes of [5, 60, 180, 720, 1440]) {
      const period = periodFor(minutes);
      expect(period % 60).toBe(0);
      expect(period).toBeGreaterThanOrEqual(60);
      expect(period).toBeLessThanOrEqual(3600);
    }
  });
});

describe("getMetrics", () => {
  beforeEach(() => send.mockReset());

  it("latest 取的是最新的点——CloudWatch 返回的是倒序", async () => {
    // 倒序：最新值 10 排在最前
    send.mockResolvedValueOnce(reply([10, 8, 6, 4, 2, 1]));

    const result = await getMetrics(["lambda"], 60);
    const errors = result.metrics.find((m) => m.label === "collector 错误数");

    expect(errors?.latest).toBe(10);
    expect(errors?.max).toBe(10);
    expect(errors?.dataPoints).toBe(6);
  });

  it("识别出正在上升的指标——这正是告警看不见的那一段", async () => {
    send.mockResolvedValueOnce(reply([10, 9, 8, 2, 1, 1]));

    const result = await getMetrics(["lambda"], 60);
    const errors = result.metrics.find((m) => m.label === "collector 错误数");

    expect(errors?.trend).toBe("rising");
    expect(result.summary).toContain("正在上升");
  });

  it("识别出正在下降的指标", async () => {
    send.mockResolvedValueOnce(reply([1, 1, 2, 8, 9, 10]));

    const result = await getMetrics(["lambda"], 60);

    expect(result.metrics.find((m) => m.label === "collector 错误数")?.trend).toBe(
      "falling",
    );
  });

  it("从零涨起来算上升——没法算比例，但恰恰最值得报告", async () => {
    send.mockResolvedValueOnce(reply([5, 3, 1, 0, 0, 0]));

    const result = await getMetrics(["lambda"], 60);

    expect(result.metrics.find((m) => m.label === "collector 错误数")?.trend).toBe(
      "rising",
    );
  });

  it("点太少时不硬猜趋势", async () => {
    send.mockResolvedValueOnce(reply([1, 2]));

    const result = await getMetrics(["lambda"], 60);

    expect(result.metrics.find((m) => m.label === "collector 错误数")?.trend).toBe(
      "unknown",
    );
  });

  it("完全没有数据点时说清楚，不报成一切正常", async () => {
    send.mockResolvedValueOnce({ MetricDataResults: [] });

    const result = await getMetrics(["lambda"], 60);

    expect(result.summary).toContain("没有数据点");
    expect(result.metrics.every((m) => m.latest === null)).toBe(true);
  });

  it("按 scope 组装查询，队列指标里带上最老消息年龄", async () => {
    send.mockResolvedValueOnce({ MetricDataResults: [] });

    await getMetrics(["queue"], 60);

    const queries = (send.mock.calls[0]![0] as { input: { MetricDataQueries: unknown[] } })
      .input.MetricDataQueries as { MetricStat: { Metric: { MetricName: string } } }[];
    const names = queries.map((q) => q.MetricStat.Metric.MetricName);

    expect(names).toContain("ApproximateAgeOfOldestMessage");
  });
});

describe("queueOldestMessageAge", () => {
  beforeEach(() => send.mockReset());

  it("返回最新的年龄取值", async () => {
    send.mockResolvedValueOnce({ MetricDataResults: [{ Id: "age", Values: [7200, 60] }] });

    expect(await queueOldestMessageAge("https://sqs.test/dlq")).toBe(7200);
  });

  it("查询失败时返回 null 而不是 0——0 会被读成队列很新", async () => {
    send.mockRejectedValueOnce(new Error("AccessDenied"));

    expect(await queueOldestMessageAge("https://sqs.test/dlq")).toBeNull();
  });

  it("没有数据点时返回 null", async () => {
    send.mockResolvedValueOnce({ MetricDataResults: [{ Id: "age", Values: [] }] });

    expect(await queueOldestMessageAge("https://sqs.test/dlq")).toBeNull();
  });
});
