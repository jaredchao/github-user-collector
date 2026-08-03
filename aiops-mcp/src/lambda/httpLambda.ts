import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "../server.js";
import { isAuthorized } from "./bearerAuth.js";

/** Function URL 的请求事件（payload 格式 2.0，只取用得到的字段）。 */
type FunctionUrlEvent = Readonly<{
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext?: { http?: { method?: string } };
}>;

type FunctionUrlResponse = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS = { "content-type": "application/json" };

const jsonError = (
  statusCode: number,
  code: number,
  message: string,
): FunctionUrlResponse => ({
  statusCode,
  headers: JSON_HEADERS,
  // 用 JSON-RPC 的错误形状回，客户端解析路径统一
  body: JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }),
});

/** Function URL 事件转成 Web 标准 Request。 */
const toRequest = (event: FunctionUrlEvent): Request => {
  const method = event.requestContext?.http?.method ?? "POST";
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `https://mcp.invalid${event.rawPath ?? "/"}${query}`;

  const headers = new Headers();
  for (const [key, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) headers.set(key, value);
  }

  const hasBody = method !== "GET" && method !== "HEAD" && event.body !== undefined;
  const body = hasBody
    ? event.isBase64Encoded
      ? Buffer.from(event.body as string, "base64")
      : (event.body as string)
    : undefined;

  return new Request(url, { method, headers, body });
};

const toLambdaResponse = async (response: Response): Promise<FunctionUrlResponse> => {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { statusCode: response.status, headers, body: await response.text() };
};

/**
 * 公网上的只读 MCP 端点。
 *
 * 装配的是 read-only 模式：这个端点没有任何写工具，连 import 都没有。
 * 调用方也不需要 AWS 凭证——用的是 Lambda 执行角色，那个角色本身也只有
 * 只读权限。这正是远程形态的价值：换一台电脑、给同事一个 token 就能查，
 * 不必给出 IAM 用户。
 *
 * 传输用无状态模式 + JSON 响应：我们的工具全是请求-响应式的，没有服务端
 * 主动推送，所以不需要 SSE 流，也就不需要 Lambda 的响应流式化。每个请求
 * 各自完整，天然适配无状态的函数计算。
 */
export const handler = async (
  event: FunctionUrlEvent,
): Promise<FunctionUrlResponse> => {
  const expectedToken = process.env.AIOPS_MCP_TOKEN ?? "";
  if (!expectedToken) {
    // 没配 token 就整个端点关闭，而不是放行——配置缺失时要往安全的一侧倒
    return jsonError(503, -32000, "服务端未配置访问令牌，端点不可用");
  }

  if (!isAuthorized(event.headers?.authorization, expectedToken)) {
    return jsonError(401, -32001, "缺少或错误的访问令牌");
  }

  /*
   * 只处理 POST。
   *
   * Streamable HTTP 的 GET 是"打开一条 SSE 流等服务端推送"，DELETE 是"终止会话"。
   * 无状态模式两者都无从谈起，而把 GET 交给 transport 会拿到一个永不结束的流——
   * 实测 await response.text() 直接挂住，在 Lambda 上就是白烧到 120 秒超时。
   * 明确回 405 让客户端立刻降级到纯请求-响应模式。
   */
  const method = event.requestContext?.http?.method ?? "POST";
  if (method !== "POST") {
    return jsonError(405, -32002, `无状态端点只接受 POST，收到 ${method}`);
  }

  const server = createServer("read-only");
  const transport = new WebStandardStreamableHTTPServerTransport({
    // 不传 sessionIdGenerator 即无状态：Lambda 每次调用可能是不同的容器，
    // 会话状态存在内存里没有意义
    enableJsonResponse: true,
  });

  try {
    await server.connect(transport);
    const response = await transport.handleRequest(toRequest(event));
    return await toLambdaResponse(response);
  } finally {
    // 不关会把这次调用的资源泄漏给复用同一容器的下一次调用
    await transport.close();
    await server.close();
  }
};
