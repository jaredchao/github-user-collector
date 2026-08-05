import { METRIC_NAMES, RATINGS, SCHEMA_VERSION, type LogRecord, type MetricName, type Rating } from "./contract.js";

// This endpoint is unauthenticated by necessity — it is called from every
// visitor's browser — so everything below treats the payload as hostile.
// Nothing is stored that was not checked, bounded, and truncated here.
const LIMITS = {
  events: 50,
  site: 64,
  session: 64,
  page: 200,
  ua: 512,
  conn: 32,
  eventId: 64,
  attrKeys: 12,
  attrKeyLength: 40,
  attrValueLength: 200,
  // 10^7 ms is nearly three hours; any timing above it is a broken clock,
  // not a slow page.
  maxValue: 10_000_000,
} as const;

// Tolerated clock skew. Devices with a wrong clock are common enough that
// dropping their samples would bias the data toward well-configured
// machines, so their timestamps are replaced rather than rejected.
const MAX_PAST_MS = 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export type ValidationResult =
  | { ok: true; records: LogRecord[]; dropped: number }
  | { ok: false; reason: string };

export function validatePayload(raw: unknown, now: number = Date.now()): ValidationResult {
  if (!isRecord(raw)) return { ok: false, reason: "payload 不是对象" };
  if (raw.v !== SCHEMA_VERSION) return { ok: false, reason: `不支持的 schema 版本: ${String(raw.v)}` };

  const site = boundedString(raw.site, LIMITS.site);
  const session = boundedString(raw.session, LIMITS.session);
  const page = boundedString(raw.page, LIMITS.page);
  if (!site) return { ok: false, reason: "site 缺失" };
  if (!session) return { ok: false, reason: "session 缺失" };
  if (!page) return { ok: false, reason: "page 缺失" };

  if (!Array.isArray(raw.events)) return { ok: false, reason: "events 不是数组" };
  if (raw.events.length === 0) return { ok: false, reason: "events 为空" };
  if (raw.events.length > LIMITS.events) {
    return { ok: false, reason: `events 超过 ${LIMITS.events} 条` };
  }

  const context = {
    v: SCHEMA_VERSION,
    sdk: boundedString(raw.sdk, 64) || "unknown",
    site,
    session,
    page,
    ua: boundedString(raw.ua, LIMITS.ua),
    conn: boundedString(raw.conn, LIMITS.conn) || "unknown",
  };

  // One bad event does not sink the batch: the rest of the session is still
  // worth keeping, and the count of what was dropped is logged.
  const records: LogRecord[] = [];
  let dropped = 0;
  for (const candidate of raw.events) {
    const record = validateEvent(candidate, context, now);
    if (record) records.push(record);
    else dropped += 1;
  }

  if (records.length === 0) return { ok: false, reason: "没有一条合法的 event" };
  return { ok: true, records, dropped };
}

type Context = Omit<LogRecord, "id" | "name" | "value" | "rating" | "at" | "attrs">;

function validateEvent(candidate: unknown, context: Context, now: number): LogRecord | undefined {
  if (!isRecord(candidate)) return undefined;

  const id = boundedString(candidate.id, LIMITS.eventId);
  if (!id) return undefined;

  const name = candidate.name;
  if (typeof name !== "string" || !isMetricName(name)) return undefined;

  const value = candidate.value;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < 0 || value > LIMITS.maxValue) return undefined;

  const rating = candidate.rating;
  if (typeof rating !== "string" || !isRating(rating)) return undefined;

  const attrs = sanitizeAttrs(candidate.attrs);

  const at = candidate.at;
  const usable = typeof at === "number" && Number.isFinite(at) && at > now - MAX_PAST_MS && at < now + MAX_FUTURE_MS;

  return {
    ...context,
    id,
    name,
    value,
    rating,
    at: usable ? at : now,
    // Marked so a page whose numbers look odd can be traced back to the
    // client clock rather than to the pipeline.
    attrs: usable ? attrs : { ...attrs, clock: "skewed" },
  };
}

function sanitizeAttrs(raw: unknown): Record<string, string | number> {
  if (!isRecord(raw)) return {};

  const entries = Object.entries(raw)
    .slice(0, LIMITS.attrKeys)
    .flatMap<[string, string | number]>(([key, value]) => {
      const safeKey = key.slice(0, LIMITS.attrKeyLength);
      if (typeof value === "number" && Number.isFinite(value)) return [[safeKey, value]];
      if (typeof value === "string") return [[safeKey, value.slice(0, LIMITS.attrValueLength)]];
      // Nested objects and arrays are refused outright: they are the part of
      // a payload that can blow up the row size in unbounded ways.
      return [];
    });

  return Object.fromEntries(entries);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.slice(0, max) : "";
}

function isMetricName(value: string): value is MetricName {
  return (METRIC_NAMES as readonly string[]).includes(value);
}

function isRating(value: string): value is Rating {
  return (RATINGS as readonly string[]).includes(value);
}
