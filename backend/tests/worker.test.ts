import { beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimitError, UpstreamError, UserNotFoundError } from "../src/errors.js";

vi.mock("../src/service.js", () => ({ fetchAndStore: vi.fn() }));

const { fetchAndStore } = await import("../src/service.js");
const { handler } = await import("../src/worker.js");

function sqsEvent(...bodies: unknown[]) {
  return {
    Records: bodies.map((body, i) => ({
      messageId: `m${i}`,
      body: typeof body === "string" ? body : JSON.stringify(body),
    })),
  };
}

beforeEach(() => {
  vi.mocked(fetchAndStore).mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("collect worker", () => {
  it("collects every message and reports no failures", async () => {
    vi.mocked(fetchAndStore).mockResolvedValue({ id: 1, username: "torvalds" } as never);

    const result = await handler(sqsEvent({ username: "torvalds" }, { username: "gaearon" }));

    expect(vi.mocked(fetchAndStore).mock.calls.map(([u]) => u)).toEqual(["torvalds", "gaearon"]);
    expect(result.batchItemFailures).toEqual([]);
  });

  // A missing GitHub user will never appear no matter how often we retry, so
  // burning three attempts and a DLQ slot on it would be pure noise.
  it("treats an unknown GitHub user as handled, not as a retryable failure", async () => {
    vi.mocked(fetchAndStore).mockRejectedValue(new UserNotFoundError("nobody"));

    const result = await handler(sqsEvent({ username: "nobody" }));

    expect(result.batchItemFailures).toEqual([]);
  });

  it.each([
    ["rate limiting", new RateLimitError("rate limited")],
    ["an upstream outage", new UpstreamError("GitHub 503")],
    ["a database error", new Error("connection reset")],
  ])("retries after %s", async (_label, error) => {
    vi.mocked(fetchAndStore).mockRejectedValue(error);

    const result = await handler(sqsEvent({ username: "torvalds" }));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
  });

  // Only the broken message goes back on the queue; the healthy one in the
  // same batch must not be collected twice.
  it("fails only the offending message in a mixed batch", async () => {
    vi.mocked(fetchAndStore)
      .mockResolvedValueOnce({ id: 1 } as never)
      .mockRejectedValueOnce(new UpstreamError("GitHub 503"));

    const result = await handler(sqsEvent({ username: "torvalds" }, { username: "gaearon" }));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m1" }]);
  });

  it.each([
    ["a non-JSON body", "not json at all"],
    ["a message without a username", { requestedAt: "2026-07-31T00:00:00Z" }],
    ["an invalid username", { username: "-bad-" }],
  ])("sends %s to the dead letter queue", async (_label, body) => {
    const result = await handler(sqsEvent(body));

    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "m0" }]);
    expect(fetchAndStore).not.toHaveBeenCalled();
  });
});
