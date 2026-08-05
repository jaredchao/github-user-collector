import { describe, expect, it } from "vitest";
import { formatBucket, formatValue, ratePercentile, unitOf } from "./metrics";

describe("ratePercentile", () => {
  it.each([
    ["LCP", 2500, "good"],
    ["LCP", 3000, "needs-improvement"],
    ["LCP", 5000, "poor"],
    ["CLS", 0.05, "good"],
    ["CLS", 0.3, "poor"],
    ["INP", 200, "good"],
    ["TTFB", 1000, "needs-improvement"],
  ] as const)("%s at %d is %s", (metric, value, expected) => {
    expect(ratePercentile(metric, value)).toBe(expected);
  });

  // A custom mark or an error count has no universal scale, so colouring it
  // green or red would be an invented judgement.
  it("leaves metrics without a scale neutral", () => {
    expect(ratePercentile("CUSTOM", 9999)).toBe("neutral");
    expect(ratePercentile("ERROR", 50)).toBe("neutral");
  });
});

describe("formatValue", () => {
  it("switches to seconds above a second", () => {
    expect(formatValue("LCP", 850)).toBe("850 ms");
    expect(formatValue("LCP", 2500)).toBe("2.50 s");
  });

  it("keeps CLS unitless with three decimals", () => {
    expect(formatValue("CLS", 0.0834)).toBe("0.083");
  });

  it("renders an error count as a whole number", () => {
    expect(formatValue("ERROR", 3.4)).toBe("3");
  });

  it("labels units per metric", () => {
    expect(unitOf("CLS")).toBe("score");
    expect(unitOf("ERROR")).toBe("次");
    expect(unitOf("LCP")).toBe("ms");
  });
});

describe("formatBucket", () => {
  const iso = "2026-08-05T09:30:00.000Z";

  // A day-wide bucket labelled with a time of day claims a precision the
  // data does not have.
  it("drops the time of day for day-wide buckets", () => {
    expect(formatBucket(iso, 86400)).not.toMatch(/:/);
  });

  it("keeps hours and minutes for fine buckets", () => {
    expect(formatBucket(iso, 60)).toMatch(/\d{2}:\d{2}/);
  });
});
