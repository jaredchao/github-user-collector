import { timingSafeEqual } from "node:crypto";

/**
 * 校验 Bearer token。
 *
 * Function URL 的 AuthType 是 NONE——不是疏忽，是没得选：AWS_IAM 要求调用方
 * 做 SigV4 签名，而 MCP 客户端只能带静态 header，签不出来。所以端点是公开的，
 * 保护完全落在这个函数上。
 *
 * 用时间安全比较而不是 ===：字符串比较会在第一个不同的字符处提前返回，
 * 攻击者能靠响应时间逐位试出 token。这个端点在公网上，值得多这一行。
 */
export const isAuthorized = (
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean => {
  if (!expectedToken) return false;

  const prefix = "Bearer ";
  if (!authorizationHeader?.startsWith(prefix)) return false;

  const presented = Buffer.from(authorizationHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);

  // timingSafeEqual 要求等长，长度不同直接判否——长度本身不是秘密
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
};
