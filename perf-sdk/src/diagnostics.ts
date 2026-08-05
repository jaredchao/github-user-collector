import { observe } from "./observe";
import type { Reporter } from "./vitals";

// A busy page loads hundreds of resources. Reporting all of them would cost
// more bandwidth than the page itself and drown the useful signal, so only
// slow ones are sampled, up to a per-page ceiling.
const SLOW_RESOURCE_MS = 500;
const MAX_RESOURCES_PER_PAGE = 30;
const MAX_ERRORS_PER_PAGE = 10;

export interface Diagnostics {
  disconnect(): void;
}

export interface DiagnosticsOptions {
  captureResources: boolean;
  captureLongTasks: boolean;
  captureErrors: boolean;
  /** Our own ingest endpoint, excluded so the SDK does not measure itself. */
  endpoint: string;
}

export function collectDiagnostics(report: Reporter, options: DiagnosticsOptions): Diagnostics {
  const observers: (PerformanceObserver | undefined)[] = [];
  const teardown: (() => void)[] = [];

  if (options.captureResources) {
    let reported = 0;
    observers.push(
      observe("resource", (entries) => {
        for (const entry of entries) {
          if (reported >= MAX_RESOURCES_PER_PAGE) return;
          const resource = entry as PerformanceResourceTiming;
          if (resource.duration < SLOW_RESOURCE_MS) continue;
          if (resource.name.startsWith(options.endpoint)) continue;

          reported += 1;
          report("RESOURCE", Math.round(resource.duration), {
            url: trimUrl(resource.name),
            kind: resource.initiatorType || "other",
            // Zero on cross-origin responses without Timing-Allow-Origin.
            bytes: resource.transferSize ?? 0,
          });
        }
      }),
    );
  }

  if (options.captureLongTasks) {
    observers.push(
      observe("longtask", (entries) => {
        for (const entry of entries) {
          report("LONGTASK", Math.round(entry.duration), { name: entry.name });
        }
      }),
    );
  }

  if (options.captureErrors) {
    let reported = 0;

    const onError = (event: ErrorEvent): void => {
      if (reported >= MAX_ERRORS_PER_PAGE) return;
      reported += 1;
      // Value is a count, not a duration: the dashboard sums it per minute.
      report("ERROR", 1, {
        message: String(event.message ?? "unknown").slice(0, 200),
        source: `${trimUrl(event.filename ?? "")}:${event.lineno ?? 0}`,
      });
    };

    const onRejection = (event: PromiseRejectionEvent): void => {
      if (reported >= MAX_ERRORS_PER_PAGE) return;
      reported += 1;
      report("ERROR", 1, {
        message: String(event.reason ?? "unhandled rejection").slice(0, 200),
        source: "unhandledrejection",
      });
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    teardown.push(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
  }

  return {
    disconnect() {
      for (const observer of observers) observer?.disconnect();
      for (const off of teardown) off();
    },
  };
}

// Query strings carry tokens and personal data, and the path alone is enough
// to identify which resource was slow.
function trimUrl(url: string): string {
  if (!url) return "";
  const withoutQuery = url.split("?")[0] ?? url;
  return withoutQuery.slice(0, 200);
}
