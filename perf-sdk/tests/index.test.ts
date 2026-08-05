import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";

const { onCLS, onFCP, onINP, onLCP, onTTFB } = vi.hoisted(() => ({
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

vi.mock("web-vitals", () => ({ onCLS, onFCP, onINP, onLCP, onTTFB }));

import { init, reset } from "../src/index";
import type { Transport } from "../src/transport";
import type { PerfPayload } from "../src/types";
import { fakeObserver } from "./fake-observer";

// Only the diagnostics collectors still use PerformanceObserver directly;
// the vitals come from the mocked library above.
const OBSERVED_TYPES = ["resource", "longtask"];

function collector(): { sent: PerfPayload[]; transport: Transport } {
  const sent: PerfPayload[] = [];
  return {
    sent,
    transport: {
      send(_endpoint, payload) {
        sent.push(payload);
        return true;
      },
    },
  };
}

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    name: "LCP",
    value: 1800,
    rating: "good",
    delta: 1800,
    id: "v5-1",
    navigationType: "navigate",
    entries: [],
    ...overrides,
  } as Metric;
}

function emit(hook: { mock: { calls: unknown[][] } }, value: Metric): void {
  const handler = hook.mock.calls[0]?.[0] as ((m: Metric) => void) | undefined;
  if (!handler) throw new Error("SDK 没有订阅这个指标");
  handler(value);
}

const OPTIONS = { endpoint: "https://ingest.test/v1/collect", site: "demo" };

describe("init", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeObserver.install(OBSERVED_TYPES);
  });

  afterEach(() => {
    reset();
    fakeObserver.restore();
    vi.restoreAllMocks();
  });

  it("records a custom mark and flushes it on demand", () => {
    const { sent, transport } = collector();
    const perf = init(OPTIONS, transport);

    perf.mark("search", 240, { query: "torvalds" });
    perf.flush();

    expect(sent).toHaveLength(1);
    const event = sent[0]?.events[0];
    expect(event).toMatchObject({ name: "CUSTOM", value: 240 });
    expect(event?.attrs).toEqual({ query: "torvalds", mark: "search" });
  });

  // A bad timing source (a clock that jumped, a browser bug) would otherwise
  // land in the percentiles and never be explainable afterwards.
  it("drops non-finite and negative values", () => {
    const { sent, transport } = collector();
    const perf = init(OPTIONS, transport);

    perf.mark("bad", Number.NaN);
    perf.mark("worse", -1);
    perf.mark("infinite", Number.POSITIVE_INFINITY);
    perf.flush();

    expect(sent).toHaveLength(0);
  });

  it("reports nothing when the session loses the sampling draw", () => {
    const { sent, transport } = collector();
    const perf = init({ ...OPTIONS, sampleRate: 0 }, transport);

    perf.mark("search", 100);
    perf.flush();

    expect(perf.sampled).toBe(false);
    expect(sent).toHaveLength(0);
    // An unsampled session must not pay for the library either.
    expect(onLCP).not.toHaveBeenCalled();
  });

  it("ignores a second init instead of double-reporting", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { sent, transport } = collector();

    const first = init(OPTIONS, transport);
    const second = init(OPTIONS, transport);
    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledOnce();

    second.mark("once", 10);
    second.flush();
    expect(sent[0]?.events).toHaveLength(1);
  });

  it("buffers a vital and sends it when the page goes away", () => {
    const { sent, transport } = collector();
    init(OPTIONS, transport);

    emit(onLCP, metric({ value: 1800 }));
    expect(sent).toHaveLength(0);

    window.dispatchEvent(new Event("pagehide"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.events.map((e) => e.name)).toContain("LCP");
  });

  // Listeners fire in registration order. The library reports on the same
  // hide signal we flush on, so it has to subscribe first — otherwise the
  // final LCP lands in a buffer that was already emptied.
  it("subscribes to the library before attaching its own hide listener", () => {
    const order: string[] = [];
    onLCP.mockImplementation(() => order.push("web-vitals"));
    const addEventListener = vi
      .spyOn(window, "addEventListener")
      .mockImplementation(((type: string) => {
        if (type === "pagehide") order.push("sdk-pagehide");
      }) as never);

    const { transport } = collector();
    init(OPTIONS, transport);
    addEventListener.mockRestore();

    expect(order).toEqual(["web-vitals", "sdk-pagehide"]);
  });

  it("does not flush when the tab merely becomes visible again", () => {
    const { sent, transport } = collector();
    init(OPTIONS, transport);

    emit(onLCP, metric());
    document.dispatchEvent(new Event("visibilitychange"));

    // jsdom reports visibilityState "visible", so this is the wrong moment.
    expect(sent).toHaveLength(0);
  });

  it("detaches everything on stop", () => {
    const { sent, transport } = collector();
    const perf = init(OPTIONS, transport);
    perf.stop();

    emit(onLCP, metric());
    window.dispatchEvent(new Event("pagehide"));

    expect(sent).toHaveLength(0);
  });

  it("keeps the library's rating rather than rating vitals itself", () => {
    const { sent, transport } = collector();
    const perf = init(OPTIONS, transport);

    emit(onFCP, metric({ name: "FCP", value: 4000, rating: "poor" }));
    perf.flush();

    expect(sent[0]?.events[0]).toMatchObject({ name: "FCP", rating: "poor" });
  });

  it("rates its own metrics, which the library does not own", () => {
    const { sent, transport } = collector();
    const perf = init(OPTIONS, transport);

    fakeObserver.emit("resource", [
      { name: "https://cdn.test/slow.js", duration: 4000, initiatorType: "script" } as never,
    ]);
    perf.flush();

    expect(sent[0]?.events[0]).toMatchObject({ name: "RESOURCE", rating: "poor" });
  });

  it("subscribes to every vital exactly once", () => {
    const { transport } = collector();
    init(OPTIONS, transport);

    for (const hook of [onTTFB, onFCP, onLCP, onCLS, onINP]) {
      expect(hook).toHaveBeenCalledOnce();
    }
  });
});
