import { describe, expect, it } from "vitest";
import { rate } from "../src/rating";

// Only the metrics web-vitals does not own are rated here. LCP, INP, CLS,
// FCP and TTFB arrive already rated by the library — see vitals.ts.
describe("rate", () => {
  const cases: Array<[Parameters<typeof rate>[0], number, string]> = [
    ["RESOURCE", 1000, "good"],
    ["RESOURCE", 1000.1, "needs-improvement"],
    ["RESOURCE", 3000, "needs-improvement"],
    ["RESOURCE", 3000.1, "poor"],
    ["LONGTASK", 100, "good"],
    ["LONGTASK", 200, "needs-improvement"],
    ["LONGTASK", 300, "poor"],
  ];

  it.each(cases)("%s at %d is %s", (metric, value, expected) => {
    expect(rate(metric, value)).toBe(expected);
  });

  it("rates metrics without a scale as neutral", () => {
    expect(rate("CUSTOM", 99999)).toBe("good");
    expect(rate("ERROR", 1)).toBe("good");
  });

  // Reached only if the library ever hands us a metric without a rating.
  // Neutral is the honest answer: inventing a threshold that disagrees with
  // web-vitals would be worse than saying nothing.
  it("does not second-guess the library's metrics", () => {
    expect(rate("LCP", 9999)).toBe("good");
    expect(rate("CLS", 5)).toBe("good");
  });
});
