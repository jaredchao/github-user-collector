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

const MESSAGES: Record<number, string> = {
  400: "用户名格式不对",
  404: "找不到这个 GitHub 用户",
  429: "请求太频繁，GitHub 限流了，请稍后再试",
  500: "服务器出错了，请稍后再试",
  502: "GitHub 暂时无法访问，请稍后再试",
};

export async function fetchUser(username: string): Promise<GitHubUser> {
  const baseUrl = import.meta.env.VITE_API_URL;

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
    throw new ApiError(MESSAGES[response.status] ?? `请求失败（${response.status}）`, response.status);
  }

  return (await response.json()) as GitHubUser;
}
