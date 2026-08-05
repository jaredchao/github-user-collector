import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from "web-vitals";
import type { MetricName, Rating } from "./types";

// Web Vitals come from Google's own library rather than hand-rolled
// observers. The measurement rules are not stable trivia — they track
// browser behaviour that keeps changing — and getting them subtly wrong
// biases every number in one direction, which is worse than having no
// number at all. Specifically, the library handles:
//
//   - stopping LCP at the first interaction (a big image the user clicked
//     open is not the largest contentful paint)
//   - the real INP percentile, using performance.interactionCount so that
//     interactions faster than the observer threshold still count
//   - bfcache restores, which start a fresh measurement instead of
//     reporting nothing for the second visit
//   - prerendered pages, corrected against activationStart
//
// This module is the adapter: it maps the library's Metric onto our own
// event shape and leaves everything else (queueing, sampling, transport)
// alone.

export type Reporter = (
  name: MetricName,
  value: number,
  attrs?: Record<string, string | number>,
  /** The library's own rating. Omitted for metrics it does not own. */
  rating?: Rating,
) => void;

export interface VitalsCollector {
  disconnect(): void;
}

export function collectVitals(report: Reporter): VitalsCollector {
  let stopped = false;

  const handle = (metric: Metric): void => {
    if (stopped) return;
    report(metric.name as MetricName, round(metric.value), toAttrs(metric), metric.rating);
  };

  // Each of these fires once the metric is final: LCP at the first
  // interaction or when the page is hidden, CLS and INP when it is hidden,
  // TTFB and FCP as soon as they are known. Registering them before our own
  // pagehide listener matters — listeners run in registration order, so the
  // library's report lands in the queue before we flush it.
  onTTFB(handle);
  onFCP(handle);
  onLCP(handle);
  onCLS(handle);
  onINP(handle);

  return {
    disconnect() {
      // web-vitals has no unsubscribe. Stopping the forwarding is as far as
      // this goes; the observers stay alive until the document does.
      stopped = true;
    },
  };
}

function toAttrs(metric: Metric): Record<string, string | number> {
  // navigationType distinguishes a bfcache restore ("back-forward") and a
  // prerender from a cold load. Without it those look like unexplained
  // outliers in the data.
  const attrs: Record<string, string | number> = { nav: metric.navigationType };
  const last = metric.entries[metric.entries.length - 1];

  if (metric.name === "LCP") {
    const entry = last as (PerformanceEntry & { element?: Element; url?: string }) | undefined;
    attrs.element = describeElement(entry?.element) || entry?.url || "unknown";
  }
  if (metric.name === "INP" || metric.name === "CLS") {
    // How many entries the final value was built from — a CLS of 0.2 from
    // one big shift calls for different work than the same score from
    // twenty small ones.
    attrs.entries = metric.entries.length;
  }

  return attrs;
}

export function describeElement(element: Element | undefined): string {
  if (!element) return "";
  const id = element.id ? `#${element.id}` : "";
  const cls =
    typeof element.className === "string" && element.className
      ? `.${element.className.trim().split(/\s+/)[0]}`
      : "";
  return `${element.tagName.toLowerCase()}${id}${cls}`.slice(0, 100);
}

// CLS is a small unitless score; the others are milliseconds where a
// fraction of one is noise.
function round(value: number): number {
  return value < 1 ? Math.round(value * 10_000) / 10_000 : Math.round(value * 10) / 10;
}
