import { init } from "@zuoye/perf-sdk";

// Real-user monitoring for this app. The samples land in the same pipeline
// the perf dashboard reads, under site=zuoye-frontend.
//
// Without an ingest endpoint configured the SDK never starts and the import
// is tree-shaken out of the bundle entirely, so local development and the
// test suite carry none of it.
export function startTelemetry(): void {
  const endpoint = import.meta.env.VITE_INGEST_URL;
  if (!endpoint) return;

  init({
    endpoint,
    site: import.meta.env.VITE_TELEMETRY_SITE ?? "zuoye-frontend",
  });
}
