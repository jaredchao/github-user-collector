export interface PerfOptions {
  /** Ingest endpoint, e.g. https://perf.example.com/v1/collect */
  endpoint: string;
  /** Which site the samples belong to. Becomes a dimension in the dashboard. */
  site: string;
  /** 0..1. Sampling is per session, not per event — see resolveConfig. */
  sampleRate?: number;
  /** Flush once this many events are buffered. */
  batchSize?: number;
  flushIntervalMs?: number;
  /** Override page naming when the default path normalization is too coarse. */
  pageName?: () => string;
  captureResources?: boolean;
  captureErrors?: boolean;
  captureLongTasks?: boolean;
  /** Log what would be sent instead of staying silent on failure. */
  debug?: boolean;
}

export interface ResolvedConfig {
  endpoint: string;
  site: string;
  sampleRate: number;
  batchSize: number;
  flushIntervalMs: number;
  pageName: () => string;
  captureResources: boolean;
  captureErrors: boolean;
  captureLongTasks: boolean;
  debug: boolean;
}

export const DEFAULTS = {
  sampleRate: 1,
  batchSize: 20,
  flushIntervalMs: 5000,
  captureResources: true,
  captureErrors: true,
  captureLongTasks: true,
  debug: false,
} as const;

export function resolveConfig(options: PerfOptions, defaultPageName: () => string): ResolvedConfig {
  if (!options.endpoint) throw new Error("perf-sdk: endpoint 不能为空");
  if (!options.site) throw new Error("perf-sdk: site 不能为空");

  const sampleRate = clamp(options.sampleRate ?? DEFAULTS.sampleRate, 0, 1);

  return {
    endpoint: options.endpoint,
    site: options.site,
    sampleRate,
    batchSize: Math.max(1, options.batchSize ?? DEFAULTS.batchSize),
    flushIntervalMs: Math.max(1000, options.flushIntervalMs ?? DEFAULTS.flushIntervalMs),
    pageName: options.pageName ?? defaultPageName,
    captureResources: options.captureResources ?? DEFAULTS.captureResources,
    captureErrors: options.captureErrors ?? DEFAULTS.captureErrors,
    captureLongTasks: options.captureLongTasks ?? DEFAULTS.captureLongTasks,
    debug: options.debug ?? DEFAULTS.debug,
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return max;
  return Math.min(max, Math.max(min, value));
}

// Sampling decision is made once per session rather than per event. Sampling
// individual events would leave a session with an LCP but no TTFB, which
// makes per-session comparisons meaningless.
export function sessionIsSampled(sampleRate: number, random: () => number = Math.random): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  return random() < sampleRate;
}
