import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAuthorized } from "../src/lambda/bearerAuth.js";
import { handler } from "../src/lambda/httpLambda.js";

const TOKEN = "s3cr3t-token-value";

const post = (body: unknown, authorization?: string) => ({
  rawPath: "/mcp",
  requestContext: { http: { method: "POST" } },
  headers: {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(authorization ? { authorization } : {}),
  },
  body: JSON.stringify(body),
  isBase64Encoded: false,
});

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0" },
  },
};

describe("isAuthorized", () => {
  it("正确的 token 通过", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
  });

  it("缺少 header、错误前缀、错误 token 一律拒绝", () => {
    expect(isAuthorized(undefined, TOKEN)).toBe(false);
    expect(isAuthorized(TOKEN, TOKEN)).toBe(false);
    expect(isAuthorized(`Basic ${TOKEN}`, TOKEN)).toBe(false);
    expect(isAuthorized(`Bearer ${TOKEN}x`, TOKEN)).toBe(false);
    expect(isAuthorized("Bearer ", TOKEN)).toBe(false);
  });

  it("服务端没配 token 时任何请求都不通过", () => {
    expect(isAuthorized(`Bearer ${TOKEN}`, "")).toBe(false);
    expect(isAuthorized("Bearer ", "")).toBe(false);
  });
});

describe("httpLambda handler", () => {
  beforeEach(() => {
    vi.stubEnv("AIOPS_MCP_TOKEN", TOKEN);
  });

  it("没配 token 时整个端点关闭，而不是放行", async () => {
    vi.stubEnv("AIOPS_MCP_TOKEN", "");

    const response = await handler(post(initialize, `Bearer ${TOKEN}`));

    expect(response.statusCode).toBe(503);
    expect(response.body).toContain("未配置访问令牌");
  });

  it("无 token 返回 401", async () => {
    const response = await handler(post(initialize));

    expect(response.statusCode).toBe(401);
  });

  it("错误 token 返回 401", async () => {
    const response = await handler(post(initialize, "Bearer wrong-token"));

    expect(response.statusCode).toBe(401);
  });

  it("正确 token 能完成 initialize 握手", async () => {
    const response = await handler(post(initialize, `Bearer ${TOKEN}`));

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      result?: { serverInfo?: { name?: string } };
    };
    expect(body.result?.serverInfo?.name).toBe("aiops-mcp");
  });

  /**
   * 无状态模式下每个请求各自完整，不要求先 initialize——这正是它能跑在
   * 函数计算上的原因：两次调用可能落在不同容器，没有共享的会话状态。
   */
  it("tools/list 不需要先 initialize，独立请求即可用", async () => {
    const response = await handler(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, `Bearer ${TOKEN}`),
    );

    expect(response.statusCode).toBe(200);
    const tools = JSON.parse(response.body).result.tools as unknown[];
    expect(tools).toHaveLength(11);
  });

  it("公网端点一个写工具都不暴露", async () => {
    const response = await handler(
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, `Bearer ${TOKEN}`),
    );

    const tools = JSON.parse(response.body).result.tools as {
      name: string;
      annotations?: { readOnlyHint?: boolean };
    }[];

    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
    const names = tools.map((tool) => tool.name);
    for (const forbidden of [
      "set_alias_weight",
      "rollback_canary",
      "redrive_dlq",
      "discard_dlq_messages",
      "restore",
    ]) {
      expect(names, `远程端点绝不能暴露 ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * 这条测试挡的是一个会烧钱的坑：把 GET 交给 transport 会拿到永不结束的
   * SSE 流，await 直接挂住，Lambda 一路烧到 120 秒超时才被杀。
   */
  it("GET 立刻返回 405，绝不挂起等 SSE 流", async () => {
    const response = await handler({
      rawPath: "/mcp",
      requestContext: { http: { method: "GET" } },
      headers: { accept: "text/event-stream", authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(405);
    expect(response.body).toContain("只接受 POST");
  });

  it("DELETE 同样被挡——无状态端点没有会话可终止", async () => {
    const response = await handler({
      rawPath: "/mcp",
      requestContext: { http: { method: "DELETE" } },
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(405);
  });

  it("未授权先于方法检查——不给未授权者探测端点行为的机会", async () => {
    const response = await handler({
      rawPath: "/mcp",
      requestContext: { http: { method: "GET" } },
      headers: {},
    });

    expect(response.statusCode).toBe(401);
  });
});
