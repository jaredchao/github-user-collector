// Mirror of perf-sdk/src/types.ts. It is duplicated rather than imported
// because the two build independently and deploy to different runtimes;
// SCHEMA_VERSION is the checked contract between them.
export const SCHEMA_VERSION = 1;

export const METRIC_NAMES = [
  "LCP",
  "FCP",
  "CLS",
  "INP",
  "TTFB",
  "RESOURCE",
  "LONGTASK",
  "CUSTOM",
  "ERROR",
] as const;

export const RATINGS = ["good", "needs-improvement", "poor"] as const;

export type MetricName = (typeof METRIC_NAMES)[number];
export type Rating = (typeof RATINGS)[number];

// One flattened sample: payload-level context merged into the event. The
// cleaner reads one of these per log line, so it never has to reassemble a
// batch that was split across log entries.
export interface LogRecord {
  v: number;
  sdk: string;
  site: string;
  session: string;
  page: string;
  ua: string;
  conn: string;
  id: string;
  name: MetricName;
  value: number;
  rating: Rating;
  at: number;
  attrs: Record<string, string | number>;
}
