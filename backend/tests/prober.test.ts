import { beforeEach, describe, expect, it, vi } from "vitest";

const { handler } = await import("../src/prober.js");

const FRESH = new Date().toISOString();
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function res(status: number, body: unknown = {}) {
  return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function stubFetch(...responses: unknown[]) {
  const spy = vi.fn();
  for (const r of responses) spy.mockResolvedValueOnce(r);
  spy.mockResolvedValue(responses.at(-1));
  vi.stubGlobal("fetch", spy);
  return spy;
}

// A healthy run: both health checks pass, the collect request is accepted,
// the read-back returns a freshly stamped record, and the intro renders.
function healthyRun() {
  return [
    res(200, { status: "ok" }),
    res(200, { status: "ok" }),
    res(202, { status: "accepted" }),
    res(200, { username: "torvalds", updatedAt: FRESH }),
    res(200, { intro: "Linus Torvalds ..." }),
  ];
}

beforeEach(() => {
  vi.stubEnv("PROBE_API_URL", "https://api.example.com");
  vi.stubEnv("PROBE_GO_URL", "https://go.example.com");
  vi.stubEnv("PROBE_USER", "torvalds");
  vi.stubEnv("PROBE_SETTLE_MS", "0");
  vi.stubEnv("PROBE_POLL_MS", "0");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("probe", () => {
  it("reports success when the whole chain works", async () => {
    stubFetch(...healthyRun());

    const result = await handler();

    expect(result.ok).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      "api-health",
      "front-door-health",
      "queue-collect",
      "read-back",
      "intro",
    ]);
    expect(result.steps.every((s) => s.ok)).toBe(true);
  });

  it("emits an embedded metric so CloudWatch can alarm on it", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    stubFetch(...healthyRun());

    await handler();

    const emf = log.mock.calls.map(([line]) => JSON.parse(String(line))).find((m) => m._aws);
    expect(emf.Success).toBe(1);
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe("ZuoyeProbe");
  });

  // The record is upserted, so it never disappears: only a recent updatedAt
  // proves the async chain actually ran. Without this check the probe stays
  // green while the worker is dead.
  it("fails when the record is stale even though the read returned 200", async () => {
    const run = healthyRun();
    run[3] = res(200, { username: "torvalds", updatedAt: STALE });
    stubFetch(...run);

    const result = await handler();

    expect(result.ok).toBe(false);
    const readBack = result.steps.find((s) => s.name === "read-back")!;
    expect(readBack.ok).toBe(false);
    expect(readBack.detail).toContain("stale");
  });

  it.each([
    ["the api is down", 0, res(503)],
    ["the front door is down", 1, res(502)],
    ["the request is rejected", 2, res(500)],
    ["the intro breaks", 4, res(503)],
  ])("fails when %s", async (_label, index, replacement) => {
    const run = healthyRun();
    run[index] = replacement;
    stubFetch(...run);

    const result = await handler();

    expect(result.ok).toBe(false);
  });

  it("keeps polling while the collection is still pending", async () => {
    const run = healthyRun();
    run.splice(3, 0, res(404, { status: "pending" }), res(404, { status: "pending" }));
    stubFetch(...run);

    const result = await handler();

    expect(result.ok).toBe(true);
  });

  it("fails when the network itself is unreachable", async () => {
    const spy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", spy);

    const result = await handler();

    expect(result.ok).toBe(false);
  });
});
