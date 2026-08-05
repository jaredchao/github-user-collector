import { resolveConfig, sessionIsSampled, type PerfOptions } from "./config";
import { collectDiagnostics } from "./diagnostics";
import { connectionType, newId, normalizePath } from "./identity";
import { rate } from "./rating";
import { createQueue } from "./queue";
import { browserTransport, type Transport } from "./transport";
import { collectVitals, type Reporter } from "./vitals";

export type { PerfOptions } from "./config";
export type { MetricName, PerfEvent, PerfPayload, Rating } from "./types";
export { SCHEMA_VERSION, SDK_VERSION } from "./types";

export interface PerfHandle {
  /** Record an application-defined timing, e.g. how long a search took. */
  mark(name: string, value: number, attrs?: Record<string, string | number>): void;
  /** Send everything buffered right now. */
  flush(): void;
  /** Stop observing and detach every listener. */
  stop(): void;
  /** False when this session lost the sampling draw and reports nothing. */
  readonly sampled: boolean;
}

// A page that calls init twice would observe and report everything twice.
let active: PerfHandle | undefined;

export function init(options: PerfOptions, transport: Transport = browserTransport): PerfHandle {
  if (active) {
    console.warn("[perf-sdk] 已经初始化过，忽略这次调用");
    return active;
  }

  const config = resolveConfig(options, () => normalizePath(location.pathname));

  if (!sessionIsSampled(config.sampleRate)) {
    active = inertHandle();
    return active;
  }

  const queue = createQueue(config, { session: newId(), ua: navigator.userAgent, conn: connectionType() }, transport);

  const report: Reporter = (name, value, attrs, rating) => {
    // A negative or non-finite timing means the browser gave us garbage;
    // storing it would poison the percentiles.
    if (!Number.isFinite(value) || value < 0) return;
    // Web Vitals arrive already rated by the library, which is the authority
    // on those thresholds. Everything else is rated here.
    queue.add({
      id: newId(),
      name,
      value,
      rating: rating ?? rate(name, value),
      at: Date.now(),
      attrs,
    });
  };

  const vitals = collectVitals(report);
  const diagnostics = collectDiagnostics(report, {
    captureResources: config.captureResources,
    captureLongTasks: config.captureLongTasks,
    captureErrors: config.captureErrors,
    endpoint: config.endpoint,
  });

  // pagehide is the reliable end-of-page signal; visibilitychange covers the
  // mobile case where the tab is backgrounded and killed without pagehide.
  //
  // These only flush. Deciding when a metric is final belongs to web-vitals,
  // which reports on the same signals — and does so first, because it
  // registered its listeners before these were attached.
  //
  // A bfcache restore needs nothing extra: the library starts a fresh
  // measurement and reports again, and the next hide flushes that too.
  const onHidden = (): void => {
    if (document.visibilityState !== "hidden") return;
    queue.flush();
  };
  const onPageHide = (): void => {
    queue.flush();
  };
  document.addEventListener("visibilitychange", onHidden);
  window.addEventListener("pagehide", onPageHide);

  active = {
    mark(name, value, attrs) {
      report("CUSTOM", value, { ...attrs, mark: name });
    },
    flush: queue.flush,
    stop() {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", onPageHide);
      vitals.disconnect();
      diagnostics.disconnect();
      queue.stop();
      active = undefined;
    },
    sampled: true,
  };

  return active;
}

// Returned to unsampled sessions so callers can use the same API without
// null checks; every method is a no-op.
function inertHandle(): PerfHandle {
  return {
    mark: () => undefined,
    flush: () => undefined,
    stop: () => {
      active = undefined;
    },
    sampled: false,
  };
}

// Test seam: lets a suite start from a clean slate without reloading jsdom.
export function reset(): void {
  active?.stop();
  active = undefined;
}
