import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { randomUUID } from "node:crypto";
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from "aws-lambda";
import { corsHeaders, parseOrigins } from "./cors.js";
import { createLogWriter, type LogWriter } from "./logs.js";
import { validatePayload } from "./validate.js";

// API Gateway allows far larger bodies than any honest batch needs. 50
// events of bounded fields cannot approach this.
const MAX_BODY_BYTES = 128 * 1024;

export interface HandlerDeps {
  writer: LogWriter;
  allowedOrigins: readonly string[];
}

export function createHandler({ writer, allowedOrigins }: HandlerDeps) {
  return async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
    const origin = event.headers?.origin ?? event.headers?.Origin;
    const cors = corsHeaders(origin, allowedOrigins);
    const method = event.requestContext?.http?.method ?? "POST";

    if (method === "OPTIONS") return { statusCode: 204, headers: cors };
    if (method !== "POST") return json(405, { error: "只接受 POST" }, cors);

    const body = event.isBase64Encoded && event.body ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
    if (!body) return json(400, { error: "请求体为空" }, cors);
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) return json(413, { error: "请求体过大" }, cors);

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { error: "请求体不是合法 JSON" }, cors);
    }

    const result = validatePayload(parsed);
    if (!result.ok) {
      // Logged at info, not error: a malformed beacon is the client's
      // problem and must not page anyone.
      console.info(`拒绝上报: ${result.reason}`);
      return json(400, { error: result.reason }, cors);
    }

    try {
      await writer.write(result.records);
    } catch (error) {
      // The browser will not retry, so the batch is lost either way. Say so
      // honestly with a 500 rather than pretending it landed.
      console.error("写入日志组失败:", error);
      return json(500, { error: "写入失败" }, cors);
    }

    if (result.dropped > 0) {
      console.info(`接收 ${result.records.length} 条，丢弃 ${result.dropped} 条非法 event`);
    }

    // 204 keeps the response body off the wire; the SDK ignores it anyway.
    return { statusCode: 204, headers: cors };
  };
}

function json(
  statusCode: number,
  body: Record<string, string>,
  headers: Record<string, string>,
): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { ...headers, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  };
}

// Module scope: created once per execution environment and reused by every
// invocation it serves, which is also what makes one log stream per instance
// the natural choice.
const logGroup = process.env.PERF_LOG_GROUP ?? "/perf/raw";
const streamName = `${new Date().toISOString().slice(0, 10)}/${randomUUID()}`;

export const handler = createHandler({
  writer: createLogWriter({ client: new CloudWatchLogsClient({}), logGroup, streamName }),
  allowedOrigins: parseOrigins(process.env.ALLOWED_ORIGINS),
});
