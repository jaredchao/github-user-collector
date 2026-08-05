export type Rating = "good" | "needs-improvement" | "poor";

export const METRICS = [
  "LCP",
  "INP",
  "CLS",
  "FCP",
  "TTFB",
  "RESOURCE",
  "LONGTASK",
  "ERROR",
  "CUSTOM",
] as const;

export type Metric = (typeof METRICS)[number];

export interface Point {
  bucket: string;
  samples: number;
  p50: number;
  p75: number;
  p95: number;
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface Timeseries {
  site: string;
  metric: Metric;
  page: string;
  from: string;
  to: string;
  bucketSeconds: number;
  /** True when percentiles were merged from rollups instead of raw samples. */
  approximate: boolean;
  points: Point[];
}

export interface MetricSummary {
  metric: Metric;
  samples: number;
  p50: number;
  p75: number;
  p95: number;
  good: number;
  needsImprovement: number;
  poor: number;
}

export interface PageStat {
  page: string;
  samples: number;
  p75: number;
  poor: number;
}
