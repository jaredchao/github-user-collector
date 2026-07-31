import type { GitHubUser } from "./types";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The Go service is the single front door: it forwards this to the collector
// Lambda (discovered via Cloud Map) and passes the verdict through, so the
// status codes below are still the Lambda's own. 502 doubles as "the Go
// service couldn't reach the Lambda".
const MESSAGES: Record<number, string> = {
  400: "用户名格式不对",
  404: "找不到这个 GitHub 用户",
  429: "请求太频繁，GitHub 限流了，请稍后再试",
  500: "服务器出错了，请稍后再试",
  502: "GitHub 暂时无法访问，请稍后再试",
  503: "采集服务暂时不可用，请稍后再试",
};

export async function fetchUser(username: string): Promise<GitHubUser> {
  const baseUrl = import.meta.env.VITE_GO_API_URL;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/users`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username }),
    });
  } catch {
    // fetch rejects on DNS failure, offline, and blocked CORS preflights.
    throw new ApiError("网络连接失败，请检查网络后重试", null);
  }

  if (!response.ok) {
    throw new ApiError(
      MESSAGES[response.status] ?? `请求失败（${response.status}）`,
      response.status,
    );
  }

  return (await response.json()) as GitHubUser;
}

// The introduction is generated asynchronously after the profile is saved
// (profile.saved -> SQS -> worker -> Go), so it lands a beat later than the
// profile itself and the UI polls for it.
const INTRO_MESSAGES: Record<number, string> = {
  400: "用户名格式不对",
  404: "找不到这个 GitHub 用户",
  503: "介绍服务暂时不可用，请稍后再试",
};

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
}

export async function fetchIntro(
  username: string,
  { intervalMs = 1500, timeoutMs = 20000 }: PollOptions = {},
): Promise<string> {
  const baseUrl = import.meta.env.VITE_GO_API_URL;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/intro?username=${encodeURIComponent(username)}`);
    } catch {
      throw new ApiError("网络连接失败，请检查网络后重试", null);
    }

    if (response.ok) {
      const body = (await response.json()) as { intro?: string };
      if (body.intro) return body.intro;
    } else if (response.status !== 404) {
      // Anything but "not generated yet" is a real failure; waiting on it
      // would just delay the error the user needs to see.
      throw new ApiError(
        INTRO_MESSAGES[response.status] ?? `请求失败（${response.status}）`,
        response.status,
      );
    }

    if (Date.now() >= deadline) {
      throw new ApiError("介绍生成超时，请稍后刷新", null);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
