import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Metric } from "web-vitals";

// The library is mocked so the suite tests our adapter, not Google's
// measurement code. Re-testing onLCP would only assert that web-vitals
// works, which is their test suite's job, and would need a real browser
// to mean anything.
const { onCLS, onFCP, onINP, onLCP, onTTFB } = vi.hoisted(() => ({
  onCLS: vi.fn(),
  onFCP: vi.fn(),
  onINP: vi.fn(),
  onLCP: vi.fn(),
  onTTFB: vi.fn(),
}));

vi.mock("web-vitals", () => ({ onCLS, onFCP, onINP, onLCP, onTTFB }));

import { collectVitals, describeElement, type Reporter } from "../src/vitals";

interface Reported {
  name: string;
  value: number;
  attrs?: Record<string, string | number>;
  rating?: string;
}

function recorder(): { reports: Reported[]; report: Reporter } {
  const reports: Reported[] = [];
  return {
    reports,
    report: (name, value, attrs, rating) => reports.push({ name, value, attrs, rating }),
  };
}

function metric(overrides: Partial<Metric> = {}): Metric {
  return {
    name: "LCP",
    value: 1834.2,
    rating: "good",
    delta: 1834.2,
    id: "v5-1",
    navigationType: "navigate",
    entries: [],
    ...overrides,
  } as Metric;
}

/** Fire the callback that collectVitals handed to a given library hook. */
function emit(hook: { mock: { calls: unknown[][] } }, value: Metric): void {
  const handler = hook.mock.calls[0]?.[0] as ((m: Metric) => void) | undefined;
  if (!handler) throw new Error("collectVitals 没有订阅这个指标");
  handler(value);
}

describe("collectVitals", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.clearAllMocks());

  it("subscribes to every Core Web Vital", () => {
    const { report } = recorder();
    collectVitals(report);

    for (const hook of [onTTFB, onFCP, onLCP, onCLS, onINP]) {
      expect(hook).toHaveBeenCalledOnce();
    }
  });

  // The library owns these thresholds; recomputing them here would give us
  // two copies to keep in sync.
  it("passes the library's rating through instead of recomputing it", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onLCP, metric({ name: "LCP", value: 4800, rating: "poor" }));

    expect(reports[0]).toMatchObject({ name: "LCP", value: 4800, rating: "poor" });
  });

  it("reports each metric under its own name", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onTTFB, metric({ name: "TTFB", value: 320 }));
    emit(onFCP, metric({ name: "FCP", value: 900 }));
    emit(onCLS, metric({ name: "CLS", value: 0.0834, rating: "good" }));
    emit(onINP, metric({ name: "INP", value: 160 }));

    expect(reports.map((r) => r.name)).toEqual(["TTFB", "FCP", "CLS", "INP"]);
  });

  it("keeps CLS precision but rounds millisecond timings", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onCLS, metric({ name: "CLS", value: 0.08342917 }));
    emit(onLCP, metric({ name: "LCP", value: 1834.28571 }));

    expect(reports[0]?.value).toBe(0.0834);
    expect(reports[1]?.value).toBe(1834.3);
  });

  // A bfcache restore reports again with navigationType "back-forward".
  // Without that tag those samples look like unexplained outliers.
  it("tags every sample with the navigation type", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onLCP, metric({ navigationType: "back-forward" }));

    expect(reports[0]?.attrs?.nav).toBe("back-forward");
  });

  it("describes the LCP element", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(
      onLCP,
      metric({
        entries: [{ element: { tagName: "IMG", id: "hero", className: "banner wide" } }] as never,
      }),
    );

    expect(reports[0]?.attrs?.element).toBe("img#hero.banner");
  });

  it("falls back to the resource url when LCP has no element", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onLCP, metric({ entries: [{ url: "https://cdn.test/hero.jpg" }] as never }));

    expect(reports[0]?.attrs?.element).toBe("https://cdn.test/hero.jpg");
  });

  it("records how many entries built a CLS or INP value", () => {
    const { reports, report } = recorder();
    collectVitals(report);

    emit(onCLS, metric({ name: "CLS", entries: [{}, {}, {}] as never }));
    emit(onINP, metric({ name: "INP", entries: [{}] as never }));

    expect(reports[0]?.attrs?.entries).toBe(3);
    expect(reports[1]?.attrs?.entries).toBe(1);
  });

  // web-vitals offers no unsubscribe, so this is the only thing disconnect
  // can honestly promise.
  it("stops forwarding after disconnect", () => {
    const { reports, report } = recorder();
    const vitals = collectVitals(report);

    vitals.disconnect();
    emit(onLCP, metric());

    expect(reports).toHaveLength(0);
  });
});

describe("describeElement", () => {
  it("builds a short selector", () => {
    expect(describeElement({ tagName: "DIV", id: "main", className: "a b" } as never)).toBe("div#main.a");
    expect(describeElement({ tagName: "IMG", id: "", className: "" } as never)).toBe("img");
  });

  it("is empty without an element", () => {
    expect(describeElement(undefined)).toBe("");
  });

  // SVG elements have an SVGAnimatedString className, not a string.
  it("survives a non-string className", () => {
    expect(describeElement({ tagName: "svg", id: "", className: {} } as never)).toBe("svg");
  });
});
