import { redact, redactError } from "./redact.js";

export type TextResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

/**
 * 摘要在前，结构化数据在后，整体过一次脱敏。
 *
 * 逐字段脱敏总会漏——队列地址、ARN、告警描述里都埋着账号 ID，而它们是
 * 结构化字段，不在"日志文本"这个显而易见的入口上。实测按字段脱敏之后，
 * 输出里仍然残留 12 位账号 ID，就是从 queueUrl 漏出来的。
 *
 * 所以在唯一的出口上兜一次：工具内部照常使用真实值（还原点存的也是原文），
 * 只有序列化给 Agent 的这一份被抹。
 *
 * 摘要放第一行是为了让 Agent 读到的第一句就是结论，不必先解析 JSON 才
 * 知道发生了什么。这对上下文预算很重要。
 */
export const ok = (summary: string, data: unknown): TextResult => ({
  content: [
    { type: "text", text: redact(`${summary}\n\n${JSON.stringify(data, null, 2)}`) },
  ],
});

/**
 * 失败也要脱敏。
 *
 * AWS 的 AccessDenied 会带上完整的 IAM ARN、账号 ID 和资源名，而错误路径
 * 天然绕开了只作用于正常返回值的处理——这是最容易漏的一处泄露。
 */
export const failed = (error: unknown): TextResult => ({
  content: [{ type: "text", text: `工具执行失败: ${redactError(error)}` }],
  isError: true,
});

export const guard = async (run: () => Promise<TextResult>): Promise<TextResult> => {
  try {
    return await run();
  } catch (error) {
    return failed(error);
  }
};
