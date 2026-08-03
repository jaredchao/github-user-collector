import { describe, expect, it } from "vitest";
import { isEnteringAlarm, parseAlarmNotifications } from "../src/lambda/alarmEvent.js";

const snsEvent = (message: unknown) => ({
  Records: [{ Sns: { Message: typeof message === "string" ? message : JSON.stringify(message) } }],
});

const alarmMessage = {
  AlarmName: "zuoye-collector-DeadLetterQueueAlarm",
  NewStateValue: "ALARM",
  OldStateValue: "OK",
  NewStateReason: "Threshold Crossed: 1 datapoint [1.0] was greater than the threshold (0.0).",
  StateChangeTime: "2026-08-03T10:00:00.000+0000",
  AlarmDescription: "死信队列有消息",
  Region: "US East (Ohio)",
};

describe("parseAlarmNotifications", () => {
  it("解析出告警的关键字段", () => {
    const [notification] = parseAlarmNotifications(snsEvent(alarmMessage));

    expect(notification?.alarmName).toBe("zuoye-collector-DeadLetterQueueAlarm");
    expect(notification?.newState).toBe("ALARM");
    expect(notification?.previousState).toBe("OK");
    expect(notification?.reason).toContain("Threshold Crossed");
  });

  it("消息不是 JSON 时跳过，不让整个调用失败", () => {
    // 有人在控制台手动往主题里发了条测试消息
    expect(parseAlarmNotifications(snsEvent("hello from console"))).toEqual([]);
  });

  it("缺少必要字段的消息不算告警", () => {
    expect(parseAlarmNotifications(snsEvent({ foo: "bar" }))).toEqual([]);
  });

  it("空事件与畸形事件都返回空数组", () => {
    expect(parseAlarmNotifications({})).toEqual([]);
    expect(parseAlarmNotifications(null)).toEqual([]);
    expect(parseAlarmNotifications({ Records: [{}] })).toEqual([]);
  });

  it("一次事件里的多条记录都要处理", () => {
    const event = {
      Records: [
        { Sns: { Message: JSON.stringify(alarmMessage) } },
        { Sns: { Message: JSON.stringify({ ...alarmMessage, AlarmName: "another" }) } },
      ],
    };

    expect(parseAlarmNotifications(event)).toHaveLength(2);
  });
});

describe("isEnteringAlarm", () => {
  it("只有进入 ALARM 才值得诊断", () => {
    const base = parseAlarmNotifications(snsEvent(alarmMessage))[0]!;

    expect(isEnteringAlarm(base)).toBe(true);
  });

  it("恢复通知不该惊动人", () => {
    const recovered = parseAlarmNotifications(
      snsEvent({ ...alarmMessage, NewStateValue: "OK", OldStateValue: "ALARM" }),
    )[0]!;

    expect(isEnteringAlarm(recovered)).toBe(false);
  });

  it("数据不足也不触发诊断", () => {
    const insufficient = parseAlarmNotifications(
      snsEvent({ ...alarmMessage, NewStateValue: "INSUFFICIENT_DATA" }),
    )[0]!;

    expect(isEnteringAlarm(insufficient)).toBe(false);
  });
});
