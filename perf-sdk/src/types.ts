// The wire contract between the SDK, the ingest Lambda, and the ECS cleaner.
// Field names are short because every byte here rides on sendBeacon during
// page unload, when the browser gives the request a hard size budget.
//
// Bump SCHEMA_VERSION when a change is not backward compatible; the cleaner
// drops payloads whose version it does not understand rather than guessing.
export const SCHEMA_VERSION = 1;

// Reported with every payload so a bad release can be identified in the raw
// logs without guessing from behaviour.
export const SDK_VERSION = "1.0.0";

export type MetricName =
  | "LCP"
  | "FCP"
  | "CLS"
  | "INP"
  | "TTFB"
  | "RESOURCE"
  | "LONGTASK"
  | "CUSTOM"
  | "ERROR";

export type Rating = "good" | "needs-improvement" | "poor";

export interface PerfEvent {
  /** Unique per sample. The pipeline is at-least-once, so the cleaner dedupes on it. */
  id: string;
  name: MetricName;
  /** Milliseconds, except CLS which is a unitless score. */
  value: number;
  rating: Rating;
  /** Epoch milliseconds when the browser observed it. */
  at: number;
  attrs?: Record<string, string | number>;
}

export interface PerfPayload {
  v: number;
  sdk: string;
  site: string;
  session: string;
  /** Normalized path, e.g. /users/:id — never the raw path with ids in it. */
  page: string;
  ua: string;
  /** navigator.connection.effectiveType, or "unknown" where unsupported. */
  conn: string;
  events: PerfEvent[];
}
