import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
const alarmNames = vi.fn<() => string[]>(() => ["dlq-alarm", "backlog-alarm"]);

vi.mock("../src/aws.js", () => ({ cloudwatch: () => ({ send }) }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({ stackName: "zuoye-collector", alarmNames: alarmNames() }),
}));

const { listAlarms } = await import("../src/tools/listAlarms.js");

const alarm = (name: string, state: string, extra: Record<string, unknown> = {}) => ({
  AlarmName: name,
  StateValue: state,
  StateReason: "阈值被越过",
  StateUpdatedTimestamp: new Date("2026-07-31T10:00:00Z"),
  MetricName: "ApproximateNumberOfMessagesVisible",
  Threshold: 0,
  ComparisonOperator: "GreaterThanThreshold",
  ...extra,
});

describe("listAlarms", () => {
  beforeEach(() => {
    send.mockReset();
    alarmNames.mockReturnValue(["dlq-alarm", "backlog-alarm"]);
  });

  it("全部正常时明确说没有触发的告警", async () => {
    send.mockResolvedValueOnce({
      MetricAlarms: [alarm("dlq-alarm", "OK"), alarm("backlog-alarm", "OK")],
    });

    const result = await listAlarms();

    expect(result.firing).toEqual([]);
    expect(result.summary).toContain("没有正在触发的告警");
  });

  it("挑出正在触发的告警并列名", async () => {
    send.mockResolvedValueOnce({
      MetricAlarms: [alarm("dlq-alarm", "ALARM"), alarm("backlog-alarm", "OK")],
    });

    const result = await listAlarms();

    expect(result.firing).toEqual(["dlq-alarm"]);
    expect(result.summary).toContain("1 个正在触发: dlq-alarm");
  });

  it("单独点出数据不足的告警——这类告警最容易被当成健康", async () => {
    send.mockResolvedValueOnce({
      MetricAlarms: [
        alarm("dlq-alarm", "OK"),
        alarm("backlog-alarm", "INSUFFICIENT_DATA", { TreatMissingData: "notBreaching" }),
      ],
    });

    const result = await listAlarms();

    expect(result.firing).toEqual([]);
    expect(result.summary).toContain("1 个数据不足: backlog-alarm");
    expect(result.alarms[1]?.treatMissingData).toBe("notBreaching");
  });

  it("栈里没有告警时不去调 CloudWatch", async () => {
    alarmNames.mockReturnValue([]);

    const result = await listAlarms();

    expect(send).not.toHaveBeenCalled();
    expect(result.summary).toContain("没有 CloudWatch 告警");
  });
});
