import type { Incident } from "../notify/types.js";
import { redact } from "../redact.js";
import { appId, appSecret, tenantAccessToken } from "./feishuAuth.js";
import { FIELDS, type TicketResult, type TicketSystem } from "./types.js";

const BASE = "https://open.feishu.cn/open-apis/bitable/v1/apps";
const TIMEOUT_MS = 10_000;
/** 查重时最多翻几页。翻不完就不建单——见下方说明。 */
const MAX_SEARCH_PAGES = 5;
const PAGE_SIZE = 100;

const appToken = (): string => process.env.AIOPS_BASE_APP_TOKEN ?? "";
const tableId = (): string => process.env.AIOPS_BASE_TABLE_ID ?? "";

const call = async (
  path: string,
  init: { method: string; body?: object },
): Promise<Record<string, unknown>> => {
  const token = await tenantAccessToken();
  const response = await fetch(`${BASE}/${appToken()}/tables/${tableId()}${path}`, {
    method: init.method,
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${token}`,
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await response.json()) as { code?: number; msg?: string; data?: unknown };
  if (body.code !== 0) {
    throw new Error(`飞书多维表格接口失败: code=${body.code} msg=${body.msg ?? "(无)"}`);
  }
  return (body.data ?? {}) as Record<string, unknown>;
};

const bullets = (items: readonly string[]): string =>
  items.length > 0 ? items.map((item) => `· ${item}`).join("\n") : "无";

/**
 * 找有没有同指纹的未处理工单。
 *
 * 返回 null 表示"确认没有"，undefined 表示"没看全，不知道"。这两者
 * 必须区分：把"没看全"当成"没有"，就会在同一个故障上反复开单。
 */
const findExisting = async (fingerprint: string): Promise<string | null | undefined> => {
  let pageToken: string | undefined;

  for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
    const data = await call("/records/search", {
      method: "POST",
      body: {
        page_size: PAGE_SIZE,
        ...(pageToken ? { page_token: pageToken } : {}),
        filter: {
          conjunction: "and",
          conditions: [
            {
              field_name: FIELDS.fingerprint,
              operator: "is",
              value: [fingerprint],
            },
          ],
        },
      },
    });

    const items = (data.items ?? []) as { record_id?: string }[];
    const hit = items.find((item) => item.record_id);
    if (hit?.record_id) return hit.record_id;

    if (!data.has_more) return null;
    pageToken = data.page_token as string | undefined;
    if (!pageToken) return null;
  }

  // 翻到上限还没看完——"没找到"只代表没看全
  return undefined;
};

/**
 * 把诊断结论写成飞书多维表格里的一行。
 *
 * 幂等靠指纹：同一个告警的同一个根因只开一单。查重用的是多维表格的
 * 记录检索接口（读主数据、强一致），不是任何走异步索引的搜索接口——
 * 后者在告警快速重复时会因为索引没跟上而重复建单。
 *
 * 宁可漏建也不重复建：翻页没翻完时直接跳过创建并说明原因。重复的工单
 * 会淹没真正的新问题，而漏建至少还有通知和日志兜底。
 */
export const feishuBaseTickets: TicketSystem = {
  system: "feishu-base",

  configured: () =>
    Boolean(appId() && appSecret() && appToken() && tableId()),

  async create(incident: Incident): Promise<TicketResult> {
    const existing = await findExisting(incident.fingerprint);

    if (existing === undefined) {
      return {
        system: this.system,
        outcome: "skipped",
        recordId: null,
        detail: "查重时未能翻完全部记录，为避免重复开单而跳过",
      };
    }
    if (existing !== null) {
      return {
        system: this.system,
        outcome: "skipped",
        recordId: existing,
        detail: `已存在同指纹工单 ${existing}`,
      };
    }

    const data = await call("/records", {
      method: "POST",
      body: {
        fields: {
          [FIELDS.fingerprint]: incident.fingerprint,
          [FIELDS.alarmName]: incident.alarm.alarmName,
          [FIELDS.status]: "待处理",
          [FIELDS.detectedAt]: incident.detectedAt,
          [FIELDS.healthyNow]: incident.diagnosis.assessment.healthyNow,
          [FIELDS.likelyCauses]: bullets(incident.diagnosis.assessment.likelyCauses),
          [FIELDS.suggestedActions]: bullets(
            incident.diagnosis.assessment.suggestedActions,
          ),
          [FIELDS.correlations]: bullets(incident.diagnosis.correlations),
        },
      },
    });

    const recordId =
      ((data.record as { record_id?: string } | undefined)?.record_id ?? null) || null;

    return {
      system: this.system,
      outcome: "created",
      recordId,
      detail: `已创建工单 ${recordId ?? "(未返回 ID)"}`,
    };
  },
};

/** 把异常转成一条失败结果，报文过脱敏。 */
export const asFailure = (system: string, error: unknown): TicketResult => ({
  system,
  outcome: "failed",
  recordId: null,
  detail: redact(error instanceof Error ? error.message : String(error)),
});
