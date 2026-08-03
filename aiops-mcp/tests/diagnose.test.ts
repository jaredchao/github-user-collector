import { beforeEach, describe, expect, it, vi } from "vitest";

const listAlarms = vi.fn();
const alarmTimeline = vi.fn();
const deploymentState = vi.fn();
const checkReady = vi.fn();
const queueDepth = vi.fn();
const tailLogs = vi.fn();
const getMetrics = vi.fn();

vi.mock("../src/tools/listAlarms.js", () => ({ listAlarms }));
vi.mock("../src/tools/alarmTimeline.js", () => ({ alarmTimeline }));
vi.mock("../src/tools/deploymentState.js", () => ({ deploymentState }));
vi.mock("../src/tools/checkReady.js", () => ({ checkReady }));
vi.mock("../src/tools/dlqDepth.js", () => ({ queueDepth }));
vi.mock("../src/tools/tailLogs.js", () => ({ tailLogs }));
vi.mock("../src/tools/metrics.js", () => ({ getMetrics }));

const { diagnose } = await import("../src/tools/diagnose.js");

const alarm = (name: string, state: string, metric: string) => ({
  name,
  type: "metric",
  state,
  reason: "阈值被越过",
  since: "2026-08-03T00:00:00.000Z",
  metric,
  threshold: 0,
  comparison: "GreaterThanThreshold",
  treatMissingData: "missing",
});

const goodMessage = JSON.stringify({
  eventType: "profile.saved",
  eventId: "evt-1",
  username: "torvalds",
  profileId: 42,
});

const setDefaults = () => {
  listAlarms.mockResolvedValue({ alarms: [], firing: [], truncated: false, summary: "" });
  alarmTimeline.mockResolvedValue({
    alarmName: "a",
    transitions: [],
    enteredAlarmAt: null,
    truncated: false,
    summary: "",
  });
  deploymentState.mockResolvedValue({
    functionName: "fn",
    alias: "live",
    canaryInProgress: false,
    versions: [
      { version: "3", codeSha256: "sha", lastModified: "2026-08-03T00:00:00.000Z", trafficShare: 1 },
    ],
    latestPublishedVersion: "3",
    summary: "",
  });
  checkReady.mockResolvedValue({ url: "u", ok: true, status: 200, latencyMs: 100, body: "", summary: "通畅" });
  queueDepth.mockResolvedValue({
    queue: "dead-letter",
    queueUrl: "u",
    visible: 0,
    inFlight: 0,
    visibleAgeSeconds: null,
    oldestEnqueuedAgeSeconds: null,
    sample: [],
    summary: "",
  });
  tailLogs.mockResolvedValue({ target: "worker", logGroup: "g", windowMinutes: 60, entries: [], summary: "" });
  getMetrics.mockResolvedValue({ windowMinutes: 60, periodSeconds: 300, metrics: [], summary: "" });
};

describe("diagnose", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setDefaults();
  });

  it("没有告警时直接说没有，不硬凑根因", async () => {
    const result = await diagnose(60);

    expect(result.firingAlarms).toEqual([]);
    expect(result.summary).toContain("没有告警在触发");
    expect(result.assessment.likelyCauses).toEqual([]);
  });

  it("告警紧跟在发布之后时判为高度相关，并建议回滚", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("release-errors", "ALARM", "Errors")],
      firing: ["release-errors"],
      truncated: false,
      summary: "",
    });
    // 告警比发布晚 5 分钟
    deploymentState.mockResolvedValue({
      functionName: "fn",
      alias: "live",
      canaryInProgress: false,
      versions: [
        { version: "7", codeSha256: "s", lastModified: "2026-08-03T10:00:00.000Z", trafficShare: 1 },
      ],
      latestPublishedVersion: "7",
      summary: "",
    });
    alarmTimeline.mockResolvedValue({
      alarmName: "release-errors",
      transitions: [],
      enteredAlarmAt: "2026-08-03T10:05:00.000Z",
      truncated: false,
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.correlations.join()).toContain("高度相关");
    expect(result.assessment.likelyCauses.join()).toContain("版本 7");
    expect(result.assessment.suggestedActions.join()).toContain("rollback_canary");
  });

  it("告警远晚于发布时明确排除发布因素", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("release-errors", "ALARM", "Errors")],
      firing: ["release-errors"],
      truncated: false,
      summary: "",
    });
    alarmTimeline.mockResolvedValue({
      alarmName: "release-errors",
      transitions: [],
      // 比发布晚三天
      enteredAlarmAt: "2026-08-06T00:00:00.000Z",
      truncated: false,
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.correlations.join()).toContain("与发布无关");
    expect(result.assessment.suggestedActions.join()).not.toContain("rollback_canary");
  });

  it("告警在响但系统健康时点出告警可能是陈旧的", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("dlq-alarm", "ALARM", "ApproximateNumberOfMessagesVisible")],
      firing: ["dlq-alarm"],
      truncated: false,
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.assessment.healthyNow).toBe(true);
    expect(result.correlations.join()).toContain("告警是陈旧的");
    expect(result.summary).toContain("系统此刻是健康的");
  });

  it("死信全是毒丸消息时判为数据问题，建议丢弃而不是重放", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("dlq-alarm", "ALARM", "ApproximateNumberOfMessagesVisible")],
      firing: ["dlq-alarm"],
      truncated: false,
      summary: "",
    });
    queueDepth.mockImplementation(async (which: string) =>
      which === "dead-letter"
        ? {
            queue: "dead-letter",
            queueUrl: "u",
            visible: 1,
            inFlight: 0,
            visibleAgeSeconds: 1892,
            oldestEnqueuedAgeSeconds: 237549,
            sample: [
              { messageId: "m-1", body: "not-a-json-event", receiveCount: 11, sentAt: null },
            ],
            summary: "",
          }
        : { queue: "main", queueUrl: "u", visible: 0, inFlight: 0, visibleAgeSeconds: null, oldestEnqueuedAgeSeconds: null, sample: [], summary: "" },
    );

    const result = await diagnose(60);

    expect(result.correlations.join()).toContain("这是数据问题，不是系统故障");
    expect(result.assessment.suggestedActions.join()).toContain("discard_dlq_messages");
    expect(result.assessment.suggestedActions.join()).not.toContain("redrive");
    // 入队 66 小时也要点出来
    expect(result.correlations.join()).toContain("小时，说明没人处理过它");
  });

  it("死信是合法消息时建议重放而不是丢弃", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("dlq-alarm", "ALARM", "ApproximateNumberOfMessagesVisible")],
      firing: ["dlq-alarm"],
      truncated: false,
      summary: "",
    });
    queueDepth.mockImplementation(async (which: string) =>
      which === "dead-letter"
        ? {
            queue: "dead-letter",
            queueUrl: "u",
            visible: 1,
            inFlight: 0,
            visibleAgeSeconds: 60,
            oldestEnqueuedAgeSeconds: 60,
            sample: [{ messageId: "m-1", body: goodMessage, receiveCount: 6, sentAt: null }],
            summary: "",
          }
        : { queue: "main", queueUrl: "u", visible: 0, inFlight: 0, visibleAgeSeconds: null, oldestEnqueuedAgeSeconds: null, sample: [], summary: "" },
    );

    const result = await diagnose(60);

    expect(result.assessment.suggestedActions.join()).toContain("redrive_dlq");
    expect(result.assessment.suggestedActions.join()).not.toContain("discard");
  });

  it("链路不通时判为当前有故障", async () => {
    checkReady.mockResolvedValue({
      url: "u",
      ok: false,
      status: 503,
      latencyMs: 100,
      body: "",
      summary: "有组件不可用",
    });

    const result = await diagnose(60);

    expect(result.assessment.healthyNow).toBe(false);
    expect(result.assessment.likelyCauses.join()).toContain("组件当前不可用");
  });

  it("错误类指标在上升时提醒，哪怕还没触发告警", async () => {
    getMetrics.mockResolvedValue({
      windowMinutes: 60,
      periodSeconds: 300,
      metrics: [
        { label: "collector 错误数", kind: "error", metricName: "Errors", stat: "Sum", latest: 3, average: 2, max: 3, trend: "rising", dataPoints: 8 },
      ],
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.correlations.join()).toContain("正在上升");
    expect(result.correlations.join()).toContain("即使尚未触发告警");
  });

  it("积压类指标上升不算恶化——队列非空时它本来就单调增长", async () => {
    getMetrics.mockResolvedValue({
      windowMinutes: 60,
      periodSeconds: 300,
      metrics: [
        { label: "dlq 最老消息可见时长(秒)", kind: "backlog", metricName: "ApproximateAgeOfOldestMessage", stat: "Maximum", latest: 1892, average: 900, max: 1892, trend: "rising", dataPoints: 20 },
      ],
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.correlations.join()).not.toContain("正在上升");
  });

  it("流量上升也不算恶化", async () => {
    getMetrics.mockResolvedValue({
      windowMinutes: 60,
      periodSeconds: 300,
      metrics: [
        { label: "API 请求数", kind: "throughput", metricName: "Count", stat: "Sum", latest: 500, average: 200, max: 500, trend: "rising", dataPoints: 20 },
      ],
      summary: "",
    });

    const result = await diagnose(60);

    expect(result.correlations.join()).not.toContain("正在上升");
  });

  it("队列类告警不去捞日志，错误类告警才捞——不无差别地把数据全抓一遍", async () => {
    listAlarms.mockResolvedValue({
      alarms: [alarm("dlq-alarm", "ALARM", "ApproximateNumberOfMessagesVisible")],
      firing: ["dlq-alarm"],
      truncated: false,
      summary: "",
    });

    await diagnose(60);

    expect(queueDepth).toHaveBeenCalled();
    expect(tailLogs).not.toHaveBeenCalled();
  });
});
