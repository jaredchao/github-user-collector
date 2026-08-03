export type AlarmNotification = Readonly<{
  alarmName: string;
  newState: string;
  previousState: string;
  reason: string;
  changedAt: string;
  description: string;
  region: string;
}>;

type SnsEvent = {
  Records?: { Sns?: { Message?: string; MessageId?: string } }[];
};

/**
 * 从 SNS 事件里取出告警通知。
 *
 * 二次校验，不只依赖订阅侧的过滤。订阅过滤器是可以被人在控制台改掉的，
 * 而这个函数是代码——真出现不该处理的事件时，宁可在这里拒绝，也不要让
 * 一个 OK 通知触发一轮"故障诊断"再发出去惊动人。
 */
export const parseAlarmNotifications = (event: unknown): AlarmNotification[] => {
  const records = (event as SnsEvent)?.Records ?? [];
  const notifications: AlarmNotification[] = [];

  for (const record of records) {
    const raw = record.Sns?.Message;
    if (!raw) continue;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // 不是 CloudWatch 告警的 JSON（可能是人手动发的测试消息），跳过
      continue;
    }

    const alarmName = parsed.AlarmName;
    const newState = parsed.NewStateValue;
    if (typeof alarmName !== "string" || typeof newState !== "string") continue;

    notifications.push({
      alarmName,
      newState,
      previousState: typeof parsed.OldStateValue === "string" ? parsed.OldStateValue : "",
      reason: typeof parsed.NewStateReason === "string" ? parsed.NewStateReason : "",
      changedAt:
        typeof parsed.StateChangeTime === "string" ? parsed.StateChangeTime : "",
      description:
        typeof parsed.AlarmDescription === "string" ? parsed.AlarmDescription : "",
      region: typeof parsed.Region === "string" ? parsed.Region : "",
    });
  }

  return notifications;
};

/** 只有进入 ALARM 才值得跑一轮诊断；恢复通知不该惊动人。 */
export const isEnteringAlarm = (notification: AlarmNotification): boolean =>
  notification.newState === "ALARM";
