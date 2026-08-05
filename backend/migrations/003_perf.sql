-- Performance monitoring tables. They live in the same database as
-- github_users because the account has one RDS instance; the perf-cleaner
-- service on ECS is their only writer, and perf-dashboard reads them through
-- that service's query API.
--
-- The migration runner replays every file on each run, so everything here
-- must be idempotent.

-- Cleaned per-event detail. One row per metric sample.
--
-- event_id is the SDK-generated id and the primary key: the log pipeline is
-- at-least-once (a checkpoint can be re-read after a crash), so the same log
-- line may arrive twice and must not double-count.
CREATE TABLE IF NOT EXISTS perf_events (
  event_id     TEXT PRIMARY KEY,
  site         TEXT NOT NULL,
  page         TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  metric       TEXT NOT NULL,
  value        DOUBLE PRECISION NOT NULL,
  rating       TEXT NOT NULL,
  device       TEXT NOT NULL DEFAULT 'unknown',
  browser      TEXT NOT NULL DEFAULT 'unknown',
  connection   TEXT NOT NULL DEFAULT 'unknown',
  attrs        JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- When the browser recorded it, not when we processed it. Rollups bucket
  -- on this so a delayed batch still lands in the minute it belongs to.
  occurred_at  TIMESTAMPTZ NOT NULL,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rollup recomputation reads a minute's worth of one site's events.
CREATE INDEX IF NOT EXISTS perf_events_bucket_idx
  ON perf_events (occurred_at, site);

-- The dashboard drills down from a rollup point into its samples.
CREATE INDEX IF NOT EXISTS perf_events_lookup_idx
  ON perf_events (site, page, metric, occurred_at DESC);

-- Per-minute aggregates, the only thing the dashboard charts read.
--
-- Recomputed from perf_events rather than incremented in place: percentiles
-- cannot be merged incrementally, and a full recompute of the touched minutes
-- makes replays and out-of-order arrivals converge to the same answer.
CREATE TABLE IF NOT EXISTS perf_rollup_1m (
  bucket       TIMESTAMPTZ NOT NULL,
  site         TEXT NOT NULL,
  page         TEXT NOT NULL,
  metric       TEXT NOT NULL,
  sample_count INTEGER NOT NULL,
  p50          DOUBLE PRECISION NOT NULL,
  p75          DOUBLE PRECISION NOT NULL,
  p95          DOUBLE PRECISION NOT NULL,
  avg_value    DOUBLE PRECISION NOT NULL,
  min_value    DOUBLE PRECISION NOT NULL,
  max_value    DOUBLE PRECISION NOT NULL,
  -- Web Vitals ratings, so the dashboard can show the good/poor split
  -- without re-deriving thresholds from raw values.
  good_count   INTEGER NOT NULL DEFAULT 0,
  ni_count     INTEGER NOT NULL DEFAULT 0,
  poor_count   INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bucket, site, page, metric)
);

-- Time-range queries scan by bucket first.
CREATE INDEX IF NOT EXISTS perf_rollup_1m_range_idx
  ON perf_rollup_1m (site, metric, bucket DESC);

-- Consumption watermark for the CloudWatch Logs poller.
--
-- One row per log group. The cleaner resumes from last_event_at minus a
-- small overlap window, which is why perf_events dedupes on event_id.
CREATE TABLE IF NOT EXISTS perf_checkpoint (
  log_group     TEXT PRIMARY KEY,
  last_event_at TIMESTAMPTZ NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
