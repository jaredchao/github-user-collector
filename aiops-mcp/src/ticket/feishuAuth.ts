const TOKEN_URL =
  "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal";
const TIMEOUT_MS = 10_000;
/** 提前一分钟过期，避免拿着刚好到期的令牌去调接口。 */
const EXPIRY_MARGIN_MS = 60_000;

export const appId = (): string => process.env.AIOPS_FEISHU_APP_ID ?? "";
export const appSecret = (): string => process.env.AIOPS_FEISHU_APP_SECRET ?? "";

type CachedToken = { value: string; expiresAt: number };

let cached: CachedToken | undefined;

/**
 * 取 tenant_access_token，进程内缓存。
 *
 * 令牌有效期两小时，而 Lambda 容器会被复用。每次调用都换一次令牌既慢又
 * 平白多一个失败点。缓存放在模块作用域，跟着容器一起活。
 */
export const tenantAccessToken = async (): Promise<string> => {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId(), app_secret: appSecret() }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  const body = (await response.json()) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
    expire?: number;
  };

  // 飞书对业务错误也返回 HTTP 200，必须看 code
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取飞书令牌失败: code=${body.code} msg=${body.msg ?? "(无)"}`);
  }

  cached = {
    value: body.tenant_access_token,
    expiresAt: Date.now() + (body.expire ?? 7200) * 1000 - EXPIRY_MARGIN_MS,
  };
  return cached.value;
};

/** 仅供测试清空缓存。 */
export const resetTokenCache = (): void => {
  cached = undefined;
};
