import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetTokenCache } from "../src/ticket/feishuAuth.js";
import { feishuBaseTickets } from "../src/ticket/feishuBase.js";
import type { Incident } from "../src/notify/types.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const incident = {
  fingerprint: "abc123def456",
  alarm: {
    alarmName: "dlq-alarm",
    newState: "ALARM",
    previousState: "OK",
    reason: "Threshold Crossed",
    changedAt: "2026-08-03T10:00:00Z",
    description: "",
    region: "us-east-2",
  },
  diagnosis: {
    correlations: ["某条关联"],
    assessment: {
      healthyNow: true,
      likelyCauses: ["毒丸消息"],
      suggestedActions: ["丢弃"],
    },
  },
  detectedAt: "2026-08-03T10:01:00Z",
} as unknown as Incident;

const jsonReply = (body: object) => ({ json: async () => body, ok: true, status: 200 });

const tokenReply = () =>
  jsonReply({ code: 0, tenant_access_token: "t-abc", expire: 7200 });

/** 请求体是第二个参数里的 body。 */
const bodyOf = (call: unknown[]): Record<string, unknown> =>
  JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;

describe("feishuBaseTickets", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resetTokenCache();
    process.env.AIOPS_FEISHU_APP_ID = "cli_x";
    process.env.AIOPS_FEISHU_APP_SECRET = "secret";
    process.env.AIOPS_BASE_APP_TOKEN = "bascn";
    process.env.AIOPS_BASE_TABLE_ID = "tbl";
  });

  it("缺任一配置都算未配置", () => {
    expect(feishuBaseTickets.configured()).toBe(true);
    delete process.env.AIOPS_BASE_TABLE_ID;
    expect(feishuBaseTickets.configured()).toBe(false);
  });

  it("没有同指纹工单时创建一条", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(jsonReply({ code: 0, data: { items: [], has_more: false } }))
      .mockResolvedValueOnce(
        jsonReply({ code: 0, data: { record: { record_id: "rec-1" } } }),
      );

    const result = await feishuBaseTickets.create(incident);

    expect(result.outcome).toBe("created");
    expect(result.recordId).toBe("rec-1");

    const created = bodyOf(fetchMock.mock.calls[2]!);
    const fields = created.fields as Record<string, unknown>;
    expect(fields["指纹"]).toBe("abc123def456");
    expect(fields["告警名"]).toBe("dlq-alarm");
    expect(fields["状态"]).toBe("待处理");
  });

  it("已有同指纹工单时跳过，不重复开单", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(
        jsonReply({ code: 0, data: { items: [{ record_id: "rec-old" }], has_more: false } }),
      );

    const result = await feishuBaseTickets.create(incident);

    expect(result.outcome).toBe("skipped");
    expect(result.recordId).toBe("rec-old");
    // 关键：没有发出创建请求
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("查重没翻完时宁可漏建也不重复建", async () => {
    fetchMock.mockResolvedValueOnce(tokenReply());
    // 永远还有下一页
    for (let i = 0; i < 10; i += 1) {
      fetchMock.mockResolvedValueOnce(
        jsonReply({ code: 0, data: { items: [], has_more: true, page_token: `p${i}` } }),
      );
    }

    const result = await feishuBaseTickets.create(incident);

    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("未能翻完");
    // 没有任何创建请求
    const created = fetchMock.mock.calls.filter((call) =>
      String(call[0]).endsWith("/records"),
    );
    expect(created).toHaveLength(0);
  });

  it("飞书用 HTTP 200 返回业务错误，必须看 code", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValueOnce(jsonReply({ code: 1254005, msg: "FieldNameNotFound" }));

    await expect(feishuBaseTickets.create(incident)).rejects.toThrow("FieldNameNotFound");
  });

  it("令牌在进程内缓存，第二次开单不再换令牌", async () => {
    fetchMock
      .mockResolvedValueOnce(tokenReply())
      .mockResolvedValue(jsonReply({ code: 0, data: { items: [], has_more: false, record: { record_id: "r" } } }));

    await feishuBaseTickets.create(incident);
    const callsAfterFirst = fetchMock.mock.calls.length;
    await feishuBaseTickets.create(incident);

    const tokenCalls = fetchMock.mock.calls.filter((call) =>
      String(call[0]).includes("tenant_access_token"),
    );
    expect(tokenCalls).toHaveLength(1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
