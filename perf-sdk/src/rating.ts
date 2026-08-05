import type { MetricName, Rating } from "./types";

// Only the metrics web-vitals does not own. LCP, INP, CLS, FCP and TTFB
// arrive already rated by the library, and keeping a second copy of those
// thresholds here would just be something to drift out of date.
//
// At or below `good` is good, above `poor` is poor, in between is
// needs-improvement — the same shape the library uses.
const THRESHOLDS: Partial<Record<MetricName, readonly [number, number]>> = {
  RESOURCE: [1000, 3000],
  LONGTASK: [100, 250],
};

export function rate(name: MetricName, value: number): Rating {
  const bounds = THRESHOLDS[name];
  // CUSTOM and ERROR have no universal scale; they are always neutral.
  if (!bounds) return "good";
  const [good, poor] = bounds;
  if (value <= good) return "good";
  if (value <= poor) return "needs-improvement";
  return "poor";
}
