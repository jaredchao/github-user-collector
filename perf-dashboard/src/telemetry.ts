import { init } from "@zuoye/perf-sdk";

// The dashboard reports its own performance through the very pipeline it
// displays. That closes the loop: if the chain breaks anywhere, the page
// showing the data is also the page that stops producing it.
//
// Without an ingest endpoint configured the SDK is simply not started —
// running the dashboard locally should not require the whole AWS chain.
export function startTelemetry(): void {
  const endpoint = import.meta.env.VITE_INGEST_URL;
  if (!endpoint) return;

  init({
    endpoint,
    site: import.meta.env.VITE_TELEMETRY_SITE ?? "perf-dashboard",
    // Long-task capture is off here: the SVG charts legitimately produce
    // them on a large window, and measuring the monitor's own rendering
    // would crowd out the sites it is meant to monitor.
    captureLongTasks: false,
  });
}
