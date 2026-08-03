import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { cloudwatch } from "../aws.js";
import { topology } from "../config.js";
import { redact } from "../redact.js";

export type AlarmSnapshot = Readonly<{
  name: string;
  state: "OK" | "ALARM" | "INSUFFICIENT_DATA";
  reason: string;
  since: string | null;
  metric: string;
  threshold: number | null;
  comparison: string;
  /** 告警配成缺数据时算触发，还是算正常——判断"假绿"时要看这一项。 */
  treatMissingData: string;
}>;

export type ListAlarmsResult = Readonly<{
  stackName: string;
  alarms: readonly AlarmSnapshot[];
  firing: readonly string[];
  summary: string;
}>;

const asState = (value?: string): AlarmSnapshot["state"] =>
  value === "ALARM" || value === "INSUFFICIENT_DATA" ? value : "OK";

/**
 * 列出本栈全部告警的当前状态。
 *
 * 只看本栈的告警，不扫全账号——运维对象是明确的，扫全账号只会
 * 让 Agent 的上下文里塞满无关噪音。
 */
export const listAlarms = async (): Promise<ListAlarmsResult> => {
  const topo = await topology();
  if (topo.alarmNames.length === 0) {
    return {
      stackName: topo.stackName,
      alarms: [],
      firing: [],
      summary: `栈 ${topo.stackName} 里没有 CloudWatch 告警`,
    };
  }

  const described = await cloudwatch().send(
    new DescribeAlarmsCommand({ AlarmNames: [...topo.alarmNames] }),
  );

  const alarms: AlarmSnapshot[] = (described.MetricAlarms ?? []).map((alarm) => ({
    name: alarm.AlarmName ?? "(未命名)",
    state: asState(alarm.StateValue),
    reason: redact(alarm.StateReason ?? ""),
    since: alarm.StateUpdatedTimestamp?.toISOString() ?? null,
    metric: alarm.MetricName ?? "(复合告警)",
    threshold: alarm.Threshold ?? null,
    comparison: alarm.ComparisonOperator ?? "",
    treatMissingData: alarm.TreatMissingData ?? "missing",
  }));

  const firing = alarms.filter((a) => a.state === "ALARM").map((a) => a.name);
  const stale = alarms.filter((a) => a.state === "INSUFFICIENT_DATA").map((a) => a.name);

  const parts = [`共 ${alarms.length} 个告警`];
  if (firing.length > 0) parts.push(`${firing.length} 个正在触发: ${firing.join(", ")}`);
  else parts.push("没有正在触发的告警");
  if (stale.length > 0) parts.push(`${stale.length} 个数据不足: ${stale.join(", ")}`);

  return {
    stackName: topo.stackName,
    alarms: Object.freeze(alarms),
    firing: Object.freeze(firing),
    summary: parts.join("；"),
  };
};
