import type { Diagnosis } from "../tools/diagnose.js";
import type { AlarmNotification } from "../lambda/alarmEvent.js";

/** 一次自动诊断的完整记录，同时喂给通知渠道和工单系统。 */
export type Incident = Readonly<{
  /** 同一个故障的稳定标识，用来去重——同一告警的同一根因不该反复开单。 */
  fingerprint: string;
  alarm: AlarmNotification;
  diagnosis: Diagnosis;
  detectedAt: string;
}>;

export type DeliveryResult = Readonly<{
  channel: string;
  delivered: boolean;
  /** 没送达时说明原因；未配置也算一种原因，且不该当成失败。 */
  detail: string;
}>;

export interface Notifier {
  readonly channel: string;
  /** 未配置时返回 false，调用方据此跳过而不是报错。 */
  configured(): boolean;
  send(incident: Incident): Promise<DeliveryResult>;
}
