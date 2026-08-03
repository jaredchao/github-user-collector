import type { Incident } from "../notify/types.js";

export type TicketResult = Readonly<{
  system: string;
  /** created 表示真开了单；skipped 表示判定为重复或看不全而没开。 */
  outcome: "created" | "skipped" | "failed" | "not-configured";
  recordId: string | null;
  detail: string;
}>;

export interface TicketSystem {
  readonly system: string;
  configured(): boolean;
  create(incident: Incident): Promise<TicketResult>;
}

/** 多维表格里约定的字段名。表里缺哪个就报哪个，不静默丢字段。 */
export const FIELDS = Object.freeze({
  fingerprint: "指纹",
  alarmName: "告警名",
  status: "状态",
  detectedAt: "发现时间",
  healthyNow: "系统当前健康",
  likelyCauses: "可能根因",
  suggestedActions: "建议动作",
  correlations: "关联发现",
});
