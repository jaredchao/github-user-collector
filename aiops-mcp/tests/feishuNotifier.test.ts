import { beforeEach, describe, expect, it, vi } from "vitest";
import { feishuNotifier } from "../src/notify/feishu.js";
import type { Incident } from "../src/notify/types.js";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const incidentWith = (overrides: {
  healthyNow?: boolean;
  reason?: string;
}): Incident =>
  ({
    fingerprint: "abc123",
    alarm: {
      alarmName: "dlq-alarm",
      newState: "ALARM",
      previousState: "OK",
      reason: overrides.reason ?? "Threshold Crossed",
      changedAt: "2026-08-03T10:00:00Z",
      description: "",
      region: "us-east-2",
    },
    diagnosis: {
      correlations: ["告警是陈旧的"],
      assessment: {
        healthyNow: overrides.healthyNow ?? false,
        likelyCauses: ["毒丸消息"],
        suggestedActions: ["丢弃"],
      },
    },
    detectedAt: "2026-08-03T10:01:00Z",
  }) as unknown as Incident;

const okReply = (body: object = { code: 0 }) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

const bodyOf = (): Record<string, unknown> =>
  JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body) as Record<
    string,
    unknown
  >;

describe("feishuNotifier", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env.AIOPS_FEISHU_WEBHOOK = "https://open.feishu.cn/hook/x";
    delete process.env.AIOPS_FEISHU_SECRET;
  });

  it("没配 webhook 就算未配置", () => {
    expect(feishuNotifier.configured()).toBe(true);
    delete process.env.AIOPS_FEISHU_WEBHOOK;
    expect(feishuNotifier.configured()).toBe(false);
  });

  it("发送交互卡片，系统健康与否用不同颜色", async () => {
    fetchMock.mockResolvedValueOnce(okReply());
    await feishuNotifier.send(incidentWith({ healthyNow: true }));

    const payload = bodyOf();
    const card = payload.card as { header: { template: string; title: { content: string } } };
    expect(payload.msg_type).toBe("interactive");
    expect(card.header.template).toBe("orange");
    expect(card.header.title.content).toContain("系统当前健康");

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(okReply());
    await feishuNotifier.send(incidentWith({ healthyNow: false }));

    const urgent = bodyOf().card as { header: { template: string } };
    expect(urgent.header.template).toBe("red");
  });

  it("没开签名校验时不带签名字段", async () => {
    fetchMock.mockResolvedValueOnce(okReply());
    await feishuNotifier.send(incidentWith({}));

    const payload = bodyOf();
    expect(payload.sign).toBeUndefined();
    expect(payload.timestamp).toBeUndefined();
  });

  it("配了签名密钥时带上时间戳与签名", async () => {
    process.env.AIOPS_FEISHU_SECRET = "s3cr3t";
    fetchMock.mockResolvedValueOnce(okReply());
    await feishuNotifier.send(incidentWith({}));

    const payload = bodyOf();
    expect(typeof payload.sign).toBe("string");
    expect((payload.sign as string).length).toBeGreaterThan(0);
    expect(typeof payload.timestamp).toBe("string");
  });

  it("飞书用 HTTP 200 返回业务错误，必须看响应体里的 code", async () => {
    fetchMock.mockResolvedValueOnce(okReply({ code: 19021, msg: "sign match fail" }));

    const result = await feishuNotifier.send(incidentWith({}));

    expect(result.delivered).toBe(false);
    expect(result.detail).toContain("sign match fail");
  });

  it("卡片内容不会带出账号 ID", async () => {
    fetchMock.mockResolvedValueOnce(okReply());
    await feishuNotifier.send(
      incidentWith({ reason: "role arn:aws:iam::089783390738:role/x" }),
    );

    expect(JSON.stringify(bodyOf())).not.toMatch(/\b\d{12}\b/);
  });

  it("成功时如实报告已送达", async () => {
    fetchMock.mockResolvedValueOnce(okReply());

    const result = await feishuNotifier.send(incidentWith({}));

    expect(result.delivered).toBe(true);
    expect(result.channel).toBe("feishu");
  });
});
