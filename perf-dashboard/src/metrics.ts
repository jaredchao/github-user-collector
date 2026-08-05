import type { Metric, Rating } from "./types";

// Same thresholds the SDK and the cleaner use. The dashboard needs them to
// colour a value it did not receive a rating for — a p75 is computed across
// samples, so it has no rating of its own.
const THRESHOLDS: Partial<Record<Metric, readonly [number, number]>> = {
  LCP: [2500, 4000],
  FCP: [1800, 3000],
  CLS: [0.1, 0.25],
  INP: [200, 500],
  TTFB: [800, 1800],
  RESOURCE: [1000, 3000],
  LONGTASK: [100, 250],
};

export function ratePercentile(metric: Metric, value: number): Rating | "neutral" {
  const bounds = THRESHOLDS[metric];
  if (!bounds) return "neutral";
  if (value <= bounds[0]) return "good";
  if (value <= bounds[1]) return "needs-improvement";
  return "poor";
}

export const METRIC_LABELS: Record<Metric, string> = {
  LCP: "最大内容绘制",
  INP: "交互到下一帧",
  CLS: "累积布局偏移",
  FCP: "首次内容绘制",
  TTFB: "首字节时间",
  RESOURCE: "慢资源加载",
  LONGTASK: "长任务",
  ERROR: "前端错误",
  CUSTOM: "自定义打点",
};

// CLS is a unitless score; ERROR is a count. Everything else is milliseconds.
export function formatValue(metric: Metric, value: number): string {
  if (metric === "CLS") return value.toFixed(3);
  if (metric === "ERROR") return String(Math.round(value));
  if (value >= 1000) return `${(value / 1000).toFixed(2)} s`;
  return `${Math.round(value)} ms`;
}

export function unitOf(metric: Metric): string {
  if (metric === "CLS") return "score";
  if (metric === "ERROR") return "次";
  return "ms";
}

export function formatBucket(iso: string, bucketSeconds: number): string {
  const date = new Date(iso);
  // A day-wide bucket labelled with a time of day reads as false precision.
  if (bucketSeconds >= 86400) {
    return date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  }
  if (bucketSeconds >= 3600) {
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit" });
  }
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
