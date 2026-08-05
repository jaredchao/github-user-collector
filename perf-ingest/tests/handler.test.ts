import { describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import type { LogRecord } from "../src/contract.js";
import { createHandler } from "../src/handler.js";
import type { LogWriter } from "../src/logs.js";

function recordingWriter(): { written: LogRecord[]; writer: LogWriter } {
  const written: LogRecord[] = [];
  return {
    written,
    writer: {
      async write(records) {
        written.push(...records);
      },
    },
  };
}

const VALID_BODY = JSON.stringify({
  v: 1,
  sdk: "perf-sdk@1.0.0",
  site: "demo",
  session: "s-1",
  page: "/",
  ua: "ua",
  conn: "4g",
  events: [{ id: "e-1", name: "LCP", value: 1200, rating: "good", at: Date.now() }],
});

function request(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    headers: { origin: "https://app.test" },
    body: VALID_BODY,
    isBase64Encoded: false,
    requestContext: { http: { method: "POST" } },
    ...overrides,
  } as APIGatewayProxyEventV2;
}

function statusOf(result: Awaited<ReturnType<ReturnType<typeof createHandler>>>): number {
  return typeof result === "object" && "statusCode" in result ? (result.statusCode ?? 0) : 0;
}

function headersOf(result: Awaited<ReturnType<ReturnType<typeof createHandler>>>): Record<string, string> {
  return typeof result === "object" && "headers" in result
    ? ((result.headers ?? {}) as Record<string, string>)
    : {};
}

describe("createHandler", () => {
  it("accepts a valid batch and answers 204", async () => {
    const { written, writer } = recordingWriter();
    const handler = createHandler({ writer, allowedOrigins: [] });

    const result = await handler(request());

    expect(statusOf(result)).toBe(204);
    expect(written).toHaveLength(1);
    expect(written[0]?.site).toBe("demo");
  });

  it("decodes a base64 body, which is how API Gateway delivers a Blob beacon", async () => {
    const { written, writer } = recordingWriter();
    const handler = createHandler({ writer, allowedOrigins: [] });

    const result = await handler(
      request({ body: Buffer.from(VALID_BODY).toString("base64"), isBase64Encoded: true }),
    );

    expect(statusOf(result)).toBe(204);
    expect(written).toHaveLength(1);
  });

  it("answers the CORS preflight without touching the writer", async () => {
    const { written, writer } = recordingWriter();
    const handler = createHandler({ writer, allowedOrigins: ["https://app.test"] });

    const result = await handler(request({ requestContext: { http: { method: "OPTIONS" } } as never }));

    expect(statusOf(result)).toBe(204);
    expect(headersOf(result)["Access-Control-Allow-Origin"]).toBe("https://app.test");
    expect(written).toHaveLength(0);
  });

  it("does not echo an origin that is not on the allow-list", async () => {
    const { writer } = recordingWriter();
    const handler = createHandler({ writer, allowedOrigins: ["https://allowed.test"] });

    const result = await handler(request({ headers: { origin: "https://evil.test" } }));

    expect(headersOf(result)["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(headersOf(result).Vary).toBe("Origin");
  });

  const badRequests: Array<[string, Partial<APIGatewayProxyEventV2>, number]> = [
    ["空请求体", { body: "" }, 400],
    ["非法 JSON", { body: "{oops" }, 400],
    ["schema 版本不符", { body: JSON.stringify({ v: 99, events: [] }) }, 400],
    ["非 POST", { requestContext: { http: { method: "GET" } } as never }, 405],
    ["请求体过大", { body: `{"v":1,"pad":"${"x".repeat(200_000)}"}` }, 413],
  ];

  it.each(badRequests)("%s 返回 %i", async (_label, overrides, expected) => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const { written, writer } = recordingWriter();
    const handler = createHandler({ writer, allowedOrigins: [] });

    const result = await handler(request(overrides));

    expect(statusOf(result)).toBe(expected);
    expect(written).toHaveLength(0);
  });

  // The browser will not retry a beacon, so a write failure has to be
  // reported honestly rather than swallowed into a 204.
  it("returns 500 when the log write fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing: LogWriter = {
      write: () => Promise.reject(new Error("throttled")),
    };
    const handler = createHandler({ writer: failing, allowedOrigins: [] });

    expect(statusOf(await handler(request()))).toBe(500);
  });
});
