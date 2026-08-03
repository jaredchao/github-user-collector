import { DescribeAlarmsCommand } from "@aws-sdk/client-cloudwatch";
import { cloudwatch } from "../aws.js";
import { topology } from "../config.js";
import { collectPages } from "../paginate.js";
import { redact } from "../redact.js";

export type AlarmSnapshot = Readonly<{
  name: string;
  /** 组合告警没有指标和阈值，只有一条 AlarmRule，但它同样会进入 ALARM。 */
  type: "metric" | "composite";
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
  /** 为 true 时结果不完整，"没有告警在响"这个结论不成立。 */
  truncated: boolean;
  summary: string;
}>;

const asState = (value?: string): AlarmSnapshot["state"] =>
  value === "ALARM" || value === "INSUFFICIENT_DATA" ? value : "OK";

/**
 * 列出本栈全部告警的当前状态。
 *
 * 只看本栈的告警，不扫全账号——运维对象是明确的，扫全账号只会让 Agent
 * 的上下文里塞满无关噪音。
 *
 * 显式请求两类告警。不传 AlarmTypes 时 DescribeAlarms 只返回指标告警，
 * 组合告警会被整批漏掉，而它同样会进入 ALARM——那就成了"告警在响，但
 * Agent 说一切正常"。
 */
export const listAlarms = async (): Promise<ListAlarmsResult> => {
  const topo = await topology();
  if (topo.alarmNames.length === 0) {
    return {
      stackName: topo.stackName,
      alarms: [],
      firing: [],
      truncated: false,
      summary: `栈 ${topo.stackName} 里没有 CloudWatch 告警`,
    };
  }

  const collected = await collectPages<AlarmSnapshot>(async (token) => {
    const page = await cloudwatch().send(
      new DescribeAlarmsCommand({
        AlarmNames: [...topo.alarmNames],
        AlarmTypes: ["MetricAlarm", "CompositeAlarm"],
        NextToken: token,
      }),
    );

    const metric: AlarmSnapshot[] = (page.MetricAlarms ?? []).map((alarm) => ({
      name: alarm.AlarmName ?? "(未命名)",
      type: "metric",
      state: asState(alarm.StateValue),
      reason: redact(alarm.StateReason ?? ""),
      since: alarm.StateUpdatedTimestamp?.toISOString() ?? null,
      metric: alarm.MetricName ?? "(表达式告警)",
      threshold: alarm.Threshold ?? null,
      comparison: alarm.ComparisonOperator ?? "",
      treatMissingData: alarm.TreatMissingData ?? "missing",
    }));

    const composite: AlarmSnapshot[] = (page.CompositeAlarms ?? []).map((alarm) => ({
      name: alarm.AlarmName ?? "(未命名)",
      type: "composite",
      state: asState(alarm.StateValue),
      reason: redact(alarm.StateReason ?? ""),
      since: alarm.StateUpdatedTimestamp?.toISOString() ?? null,
      metric: alarm.AlarmRule ?? "(组合规则)",
      threshold: null,
      comparison: "",
      treatMissingData: "不适用",
    }));

    return { items: [...metric, ...composite], nextToken: page.NextToken };
  });

  const alarms = collected.items;
  const firing = alarms.filter((a) => a.state === "ALARM").map((a) => a.name);
  const stale = alarms.filter((a) => a.state === "INSUFFICIENT_DATA").map((a) => a.name);

  const parts = [`共 ${alarms.length} 个告警`];
  if (firing.length > 0) parts.push(`${firing.length} 个正在触发: ${firing.join(", ")}`);
  else parts.push("没有正在触发的告警");
  if (stale.length > 0) parts.push(`${stale.length} 个数据不足: ${stale.join(", ")}`);
  if (collected.truncated) {
    parts.push("注意：结果已截断，可能还有没看到的告警，不能据此断定没有告警在响");
  }

  return {
    stackName: topo.stackName,
    alarms: Object.freeze(alarms),
    firing: Object.freeze(firing),
    truncated: collected.truncated,
    summary: parts.join("；"),
  };
};
