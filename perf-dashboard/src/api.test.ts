import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, fetchBreakdown, fetchSummary, fetchTimeseries } from "./api";

const FILTERS = { site: "demo", page: "", range: "24h" };

function mockFetch(response: Partial<Response>): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}), ...response });
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("api", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_PERF_API_URL", "https://perf.test");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("builds the query from the filters", async () => {
    const spy = mockFetch({ json: async () => ({ metrics: [] }) });

    await fetchSummary({ site: "demo", page: "/users/:id", range: "6h" });

    const url = new URL(spy.mock.calls[0]?.[0] as string);
    expect(url.origin + url.pathname).toBe("https://perf.test/api/summary");
    expect(url.searchParams.get("site")).toBe("demo");
    expect(url.searchParams.get("page")).toBe("/users/:id");
    expect(url.searchParams.get("range")).toBe("6h");
  });

  // Sending page= would filter on the empty string and return nothing, which
  // reads as "no data" rather than "all pages".
  it("omits an empty page instead of sending a blank filter", async () => {
    const spy = mockFetch({ json: async () => ({ metrics: [] }) });

    await fetchSummary(FILTERS);

    const url = new URL(spy.mock.calls[0]?.[0] as string);
    expect(url.searchParams.has("page")).toBe(false);
  });

  it("passes the metric through for a series", async () => {
    const spy = mockFetch({ json: async () => ({ points: [] }) });

    await fetchTimeseries(FILTERS, "INP");

    const url = new URL(spy.mock.calls[0]?.[0] as string);
    expect(url.searchParams.get("metric")).toBe("INP");
  });

  it("maps a server status to a readable message", async () => {
    mockFetch({ ok: false, status: 500 });

    await expect(fetchBreakdown(FILTERS, "LCP")).rejects.toMatchObject({
      name: "ApiError",
      status: 500,
      message: "查询服务出错了，请稍后再试",
    });
  });

  it("reports an unmapped status with its code", async () => {
    mockFetch({ ok: false, status: 418 });

    await expect(fetchSummary(FILTERS)).rejects.toThrow(/418/);
  });

  // fetch rejects on DNS failure, offline and blocked CORS preflights; none
  // of those carry a status code.
  it("turns a network failure into an ApiError without a status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed to fetch")));

    const error = await fetchSummary(FILTERS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBeNull();
  });
});
