import { createHmac } from "node:crypto";
import { redact } from "../redact.js";
import type { DeliveryResult, Incident, Notifier } from "./types.js";

const TIMEOUT_MS = 10_000;

const webhookUrl = (): string => process.env.AIOPS_FEISHU_WEBHOOK ?? "";
const signingSecret = (): string => process.env.AIOPS_FEISHU_SECRET ?? "";

/**
 * 飞书自定义机器人的签名。
 *
 * 拼出的 `timestamp\nsecret` 本身是密钥，待签名内容是空字符串——这个用法
 * 反直觉，但飞书就是这么定义的。机器人没开签名校验时不要带这两个字段。
 */
const sign = (timestamp: number, secret: string): string =>
  createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");

const bulletList = (items: readonly string[]): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- 无";

const buildCard = (incident: Incident): object => {
  const { alarm, diagnosis } = incident;
  const healthy = diagnosis.assessment.healthyNow;

  return {
    header: {
      // 系统已经恢复的告警不该和正在燃烧的告警长一个样
      template: healthy ? "orange" : "red",
      title: {
        tag: "plain_text",
        content: healthy
          ? `告警触发，但系统当前健康: ${alarm.alarmName}`
          : `告警触发，系统存在问题: ${alarm.alarmName}`,
      },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**触发原因**\n${redact(alarm.reason) || "(无)"}`,
            `**可能根因**\n${bulletList(diagnosis.assessment.likelyCauses)}`,
            `**建议动作**\n${bulletList(diagnosis.assessment.suggestedActions)}`,
            `**关联发现**\n${bulletList(diagnosis.correlations)}`,
          ].join("\n\n"),
        },
      },
      { tag: "hr" },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: `指纹 ${incident.fingerprint} · ${incident.detectedAt} · 本次诊断为只读，未执行任何处置`,
          },
        ],
      },
    ],
  };
};

export const feishuNotifier: Notifier = {
  channel: "feishu",

  configured: () => webhookUrl().length > 0,

  async send(incident: Incident): Promise<DeliveryResult> {
    const timestamp = Math.floor(Date.now() / 1000);
    const secret = signingSecret();

    const payload = {
      msg_type: "interactive",
      card: buildCard(incident),
      ...(secret ? { timestamp: String(timestamp), sign: sign(timestamp, secret) } : {}),
    };

    const response = await fetch(webhookUrl(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await response.text();
    // 飞书对业务错误也返回 HTTP 200，必须看响应体里的 code
    let code: unknown;
    try {
      code = (JSON.parse(text) as { code?: unknown }).code;
    } catch {
      code = undefined;
    }

    const delivered = response.ok && (code === 0 || code === undefined);
    return {
      channel: "feishu",
      delivered,
      detail: delivered ? "已送达" : `HTTP ${response.status}: ${redact(text).slice(0, 200)}`,
    };
  },
};
