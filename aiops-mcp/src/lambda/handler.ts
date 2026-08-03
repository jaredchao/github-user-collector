import { redact } from "../redact.js";
import { fingerprintOf } from "../notify/fingerprint.js";
import type { DeliveryResult, Incident } from "../notify/types.js";
import { notifiers } from "../notify/registry.js";
import { asFailure, feishuBaseTickets } from "../ticket/feishuBase.js";
import type { TicketResult } from "../ticket/types.js";
import { diagnose } from "../tools/diagnose.js";
import { isEnteringAlarm, parseAlarmNotifications } from "./alarmEvent.js";

/** incident 记录的检索标记。 */
const MARKER = "aiops_incident";

const DIAGNOSIS_WINDOW_MINUTES = Number(process.env.AIOPS_WINDOW_MINUTES ?? "60");

/**
 * incident 记录写成单行 JSON。
 *
 * 检索时必须用 `filter @message like "aiops_incident"` 这种子串匹配，
 * 不能用 `filter marker = "aiops_incident"`——Lambda 的 TEXT 日志格式会在
 * 这行 JSON 前面加上时间戳、请求 ID 和级别，Logs Insights 没法把 marker
 * 当成顶层字段发现，那样写一行都查不到。
 *
 * 只记关键结论，不记完整证据包：完整的 diagnosis 有几十 KB，写进日志既贵
 * 又没人看。要细节的话按 fingerprint 重新跑一次诊断更准，因为那时的系统
 * 状态才是当下的。
 */
const recordIncident = (incident: Incident): void => {
  const record = {
    marker: MARKER,
    fingerprint: incident.fingerprint,
    detectedAt: incident.detectedAt,
    alarmName: incident.alarm.alarmName,
    newState: incident.alarm.newState,
    reason: redact(incident.alarm.reason),
    healthyNow: incident.diagnosis.assessment.healthyNow,
    likelyCauses: incident.diagnosis.assessment.likelyCauses,
    suggestedActions: incident.diagnosis.assessment.suggestedActions,
    correlations: incident.diagnosis.correlations,
  };
  console.log(JSON.stringify(record));
};

const deliver = async (incident: Incident): Promise<DeliveryResult[]> => {
  const results: DeliveryResult[] = [];

  for (const notifier of notifiers()) {
    if (!notifier.configured()) {
      results.push({
        channel: notifier.channel,
        delivered: false,
        detail: "未配置，跳过",
      });
      continue;
    }
    try {
      results.push(await notifier.send(incident));
    } catch (error) {
      // 通知失败不能让整个诊断失败——诊断结论已经写进日志了，那才是主线
      results.push({
        channel: notifier.channel,
        delivered: false,
        detail: redact(error instanceof Error ? error.message : String(error)),
      });
    }
  }

  return results;
};

const openTicket = async (incident: Incident): Promise<TicketResult> => {
  if (!feishuBaseTickets.configured()) {
    return {
      system: feishuBaseTickets.system,
      outcome: "not-configured",
      recordId: null,
      detail: "未配置多维表格，跳过",
    };
  }
  try {
    return await feishuBaseTickets.create(incident);
  } catch (error) {
    // 开单失败同样不能让诊断失败
    return asFailure(feishuBaseTickets.system, error);
  }
};

export type HandlerResult = Readonly<{
  processed: number;
  skipped: number;
  incidents: readonly { fingerprint: string; alarmName: string }[];
}>;

/**
 * 告警触发的自动诊断。
 *
 * 全程只读：跑一轮 diagnose、记录结论、发通知。不做任何处置——自动处置
 * 需要人在环，而这个函数是无人值守的。它给出的是"建议动作"，由人来决定
 * 要不要在 Agent 里执行。
 */
export const handler = async (event: unknown): Promise<HandlerResult> => {
  const notifications = parseAlarmNotifications(event);
  const actionable = notifications.filter(isEnteringAlarm);
  const incidents: { fingerprint: string; alarmName: string }[] = [];

  for (const alarm of actionable) {
    const diagnosis = await diagnose(DIAGNOSIS_WINDOW_MINUTES);
    const incident: Incident = {
      fingerprint: fingerprintOf(alarm.alarmName, diagnosis),
      alarm,
      diagnosis,
      detectedAt: new Date().toISOString(),
    };

    recordIncident(incident);

    // 通知和开单互不阻塞：任一失败都不该拖累另一个，也不该拖累诊断结论
    const [delivery, ticket] = await Promise.all([deliver(incident), openTicket(incident)]);
    console.log(
      JSON.stringify({
        marker: "aiops_delivery",
        fingerprint: incident.fingerprint,
        delivery,
        ticket,
      }),
    );

    incidents.push({
      fingerprint: incident.fingerprint,
      alarmName: alarm.alarmName,
    });
  }

  return {
    processed: actionable.length,
    skipped: notifications.length - actionable.length,
    incidents,
  };
};
