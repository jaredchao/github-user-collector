import { beforeEach, describe, expect, it, vi } from "vitest";

const diagnose = vi.fn();
const send = vi.fn();
const configured = vi.fn(() => true);

vi.mock("../src/tools/diagnose.js", () => ({ diagnose }));
vi.mock("../src/notify/registry.js", () => ({
  notifiers: () => [{ channel: "test", configured, send }],
}));

const { handler } = await import("../src/lambda/handler.js");

const snsEvent = (message: object) => ({
  Records: [{ Sns: { Message: JSON.stringify(message) } }],
});

const alarmMessage = (overrides: object = {}) => ({
  AlarmName: "dlq-alarm",
  NewStateValue: "ALARM",
  OldStateValue: "OK",
  NewStateReason: "Threshold Crossed",
  StateChangeTime: "2026-08-03T10:00:00.000+0000",
  ...overrides,
});

const diagnosisWith = (causes: string[], healthyNow = false) => ({
  firingAlarms: ["dlq-alarm"],
  timelines: [],
  deployment: {},
  readiness: {},
  queues: [],
  logs: [],
  metrics: {},
  correlations: ["某条关联"],
  assessment: { healthyNow, likelyCauses: causes, suggestedActions: ["某个动作"] },
  summary: "",
});

describe("handler", () => {
  let logged: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    logged = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      logged.push(line);
    });
    diagnose.mockResolvedValue(diagnosisWith(["毒丸消息"]));
    send.mockResolvedValue({ channel: "test", delivered: true, detail: "已送达" });
    configured.mockReturnValue(true);
  });

  it("进入 ALARM 时跑一轮诊断并通知", async () => {
    const result = await handler(snsEvent(alarmMessage()));

    expect(diagnose).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(result.processed).toBe(1);
    expect(result.incidents[0]?.alarmName).toBe("dlq-alarm");
  });

  it("恢复通知不跑诊断，也不发通知", async () => {
    const result = await handler(snsEvent(alarmMessage({ NewStateValue: "OK" })));

    expect(diagnose).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("incident 记录带上可检索的标记，且是单行 JSON", async () => {
    await handler(snsEvent(alarmMessage()));

    const record = logged.find((line) => line.includes("aiops_incident"));
    expect(record).toBeDefined();
    expect(record).not.toContain("\n");

    const parsed = JSON.parse(record!) as Record<string, unknown>;
    expect(parsed.marker).toBe("aiops_incident");
    expect(parsed.likelyCauses).toEqual(["毒丸消息"]);
  });

  it("同一告警同一根因算出同一个指纹，根因变了才是新指纹", async () => {
    const first = await handler(snsEvent(alarmMessage()));
    const second = await handler(snsEvent(alarmMessage()));

    expect(second.incidents[0]?.fingerprint).toBe(first.incidents[0]?.fingerprint);

    diagnose.mockResolvedValue(diagnosisWith(["另一个根因"]));
    const third = await handler(snsEvent(alarmMessage()));

    expect(third.incidents[0]?.fingerprint).not.toBe(first.incidents[0]?.fingerprint);
  });

  it("通知渠道未配置时跳过，不当成失败", async () => {
    configured.mockReturnValue(false);

    const result = await handler(snsEvent(alarmMessage()));

    expect(send).not.toHaveBeenCalled();
    expect(result.processed).toBe(1);
    const delivery = logged.find((line) => line.includes("aiops_delivery"));
    expect(delivery).toContain("未配置，跳过");
  });

  it("通知失败不影响诊断结论落地——那才是主线", async () => {
    send.mockRejectedValue(new Error("webhook 超时"));

    const result = await handler(snsEvent(alarmMessage()));

    expect(result.processed).toBe(1);
    expect(logged.some((line) => line.includes("aiops_incident"))).toBe(true);
    expect(logged.find((line) => line.includes("aiops_delivery"))).toContain("webhook 超时");
  });

  it("告警原因里的账号 ID 不会写进 incident 记录", async () => {
    await handler(
      snsEvent(alarmMessage({ NewStateReason: "role arn:aws:iam::089783390738:role/x" })),
    );

    const record = logged.find((line) => line.includes("aiops_incident"))!;
    expect(record).not.toMatch(/\b\d{12}\b/);
  });
});
