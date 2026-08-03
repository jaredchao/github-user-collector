import { DescribeAlarmHistoryCommand } from "@aws-sdk/client-cloudwatch";
import { cloudwatch } from "../aws.js";
import { redact } from "../redact.js";

export type StateTransition = Readonly<{
  at: string;
  from: string;
  to: string;
  reason: string;
}>;

export type AlarmTimelineResult = Readonly<{
  alarmName: string;
  transitions: readonly StateTransition[];
  /** 最近一次进入 ALARM 的时刻，诊断时用来和部署时间做关联。 */
  enteredAlarmAt: string | null;
  /** 窗口内变更过多，只返回了最近一批——最早的那次变更可能不在里面。 */
  truncated: boolean;
  summary: string;
}>;

const parseTransition = (raw?: string): { from: string; to: string } => {
  if (!raw) return { from: "?", to: "?" };
  try {
    const data = JSON.parse(raw) as {
      oldState?: { stateValue?: string };
      newState?: { stateValue?: string };
    };
    return {
      from: data.oldState?.stateValue ?? "?",
      to: data.newState?.stateValue ?? "?",
    };
  } catch {
    return { from: "?", to: "?" };
  }
};

/**
 * 某个告警的状态变更时间线。
 *
 * 诊断的第一性问题是"什么时候开始坏的"——有了准确的起点，才能
 * 回头去问那个时刻附近发生过什么（部署、流量突增、依赖抖动）。
 */
export const alarmTimeline = async (
  alarmName: string,
  hours = 24,
): Promise<AlarmTimelineResult> => {
  const endDate = new Date();
  const startDate = new Date(endDate.getTime() - hours * 3600_000);

  const history = await cloudwatch().send(
    new DescribeAlarmHistoryCommand({
      AlarmName: alarmName,
      HistoryItemType: "StateUpdate",
      StartDate: startDate,
      EndDate: endDate,
      MaxRecords: 50,
      ScanBy: "TimestampDescending",
    }),
  );

  const transitions: StateTransition[] = (history.AlarmHistoryItems ?? []).map((item) => {
    const { from, to } = parseTransition(item.HistoryData);
    return {
      at: item.Timestamp?.toISOString() ?? "",
      from,
      to,
      reason: redact(item.HistorySummary ?? ""),
    };
  });

  const enteredAlarmAt = transitions.find((t) => t.to === "ALARM")?.at ?? null;
  // 按时间倒序取最近 50 条。还有更多时要说出来，否则"最早的变更"会被读错。
  const truncated = Boolean(history.NextToken);

  const summary =
    transitions.length === 0
      ? `${alarmName} 在过去 ${hours} 小时内没有状态变更——要么一直稳定，要么已经卡在同一状态超过这个窗口`
      : `${alarmName} 在过去 ${hours} 小时内变更 ${transitions.length} 次` +
        (enteredAlarmAt ? `，最近一次进入 ALARM 是 ${enteredAlarmAt}` : "") +
        (truncated ? "；窗口内变更过多，只返回了最近的一批" : "");

  return {
    alarmName,
    transitions: Object.freeze(transitions),
    enteredAlarmAt,
    truncated,
    summary,
  };
};
