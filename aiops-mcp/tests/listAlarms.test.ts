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

  it("显式请求两类告警——不传 AlarmTypes 会整批漏掉组合告警", async () => {
    send.mockResolvedValueOnce({ MetricAlarms: [alarm("dlq-alarm", "OK")] });

    await listAlarms();

    const input = (send.mock.calls[0]![0] as { input: Record<string, unknown> }).input;
    expect(input.AlarmTypes).toEqual(["MetricAlarm", "CompositeAlarm"]);
  });

  it("组合告警进入 ALARM 时同样要报出来", async () => {
    send.mockResolvedValueOnce({
      MetricAlarms: [alarm("dlq-alarm", "OK")],
      CompositeAlarms: [
        {
          AlarmName: "service-health",
          StateValue: "ALARM",
          StateReason: "子告警触发",
          StateUpdatedTimestamp: new Date("2026-08-01T00:00:00Z"),
          AlarmRule: "ALARM(dlq-alarm) OR ALARM(backlog-alarm)",
        },
      ],
    });

    const result = await listAlarms();

    expect(result.firing).toEqual(["service-health"]);
    expect(result.alarms.find((a) => a.name === "service-health")?.type).toBe("composite");
  });

  it("结果被截断时不许得出“没有告警在响”的结论", async () => {
    send.mockResolvedValue({
      MetricAlarms: [alarm("dlq-alarm", "OK")],
      NextToken: "more",
    });

    const result = await listAlarms();

    expect(result.truncated).toBe(true);
    expect(result.summary).toContain("不能据此断定没有告警在响");
  });
});
