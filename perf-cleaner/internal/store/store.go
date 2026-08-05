// Package store persists cleaned performance events and the aggregates the
// dashboard reads.
package store

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/clean"
)

// Store owns a pgx pool. Created once at startup and shared by the poller
// and the query API, which run in the same process.
type Store struct {
	pool *pgxpool.Pool
}

func New(ctx context.Context, databaseURL string) (*Store, error) {
	pool, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, err
	}
	return &Store{pool: pool}, nil
}

func (s *Store) Close() {
	if s.pool != nil {
		s.pool.Close()
	}
}

func (s *Store) Ping(ctx context.Context) error {
	return s.pool.Ping(ctx)
}

const insertEvent = `
	INSERT INTO perf_events (
	    event_id, site, page, session_id, metric, value, rating,
	    device, browser, connection, attrs, occurred_at)
	VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
	ON CONFLICT (event_id) DO NOTHING`

// InsertEvents writes a cleaned batch and reports how many rows were new.
//
// The pipeline is at-least-once: the poller re-reads an overlap window after
// every restart, so duplicates are normal traffic, not an error. ON CONFLICT
// DO NOTHING is what makes re-reading safe.
func (s *Store) InsertEvents(ctx context.Context, events []clean.Event) (int, error) {
	if len(events) == 0 {
		return 0, nil
	}

	batch := &pgx.Batch{}
	for _, event := range events {
		attrs, err := json.Marshal(event.Attrs)
		if err != nil {
			// A map that came out of encoding/json cannot fail to go back in;
			// an empty object keeps one odd row from failing the batch.
			attrs = []byte("{}")
		}
		batch.Queue(insertEvent,
			event.EventID, event.Site, event.Page, event.SessionID, event.Metric,
			event.Value, event.Rating, event.Device, event.Browser, event.Connection,
			attrs, event.OccurredAt)
	}

	results := s.pool.SendBatch(ctx, batch)
	defer results.Close()

	inserted := 0
	for range events {
		tag, err := results.Exec()
		if err != nil {
			return inserted, err
		}
		inserted += int(tag.RowsAffected())
	}
	return inserted, results.Close()
}

// Percentiles cannot be merged, so a bucket is always recomputed from its
// own events rather than updated in place. That also makes the operation
// idempotent: replaying the same log lines converges on the same aggregate.
const recomputeRollup = `
	INSERT INTO perf_rollup_1m (
	    bucket, site, page, metric, sample_count,
	    p50, p75, p95, avg_value, min_value, max_value,
	    good_count, ni_count, poor_count, updated_at)
	SELECT $1, $2, $3, $4,
	       count(*),
	       percentile_cont(0.5)  WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.95) WITHIN GROUP (ORDER BY value),
	       avg(value), min(value), max(value),
	       count(*) FILTER (WHERE rating = 'good'),
	       count(*) FILTER (WHERE rating = 'needs-improvement'),
	       count(*) FILTER (WHERE rating = 'poor'),
	       now()
	FROM perf_events
	WHERE occurred_at >= $1 AND occurred_at < $1 + interval '1 minute'
	  AND site = $2 AND page = $3 AND metric = $4
	HAVING count(*) > 0
	ON CONFLICT (bucket, site, page, metric) DO UPDATE SET
	    sample_count = EXCLUDED.sample_count,
	    p50 = EXCLUDED.p50, p75 = EXCLUDED.p75, p95 = EXCLUDED.p95,
	    avg_value = EXCLUDED.avg_value,
	    min_value = EXCLUDED.min_value,
	    max_value = EXCLUDED.max_value,
	    good_count = EXCLUDED.good_count,
	    ni_count = EXCLUDED.ni_count,
	    poor_count = EXCLUDED.poor_count,
	    updated_at = now()`

// RecomputeRollups refreshes every minute bucket the latest batch touched.
func (s *Store) RecomputeRollups(ctx context.Context, buckets []clean.Bucket) error {
	if len(buckets) == 0 {
		return nil
	}

	batch := &pgx.Batch{}
	for _, bucket := range buckets {
		batch.Queue(recomputeRollup, bucket.Minute, bucket.Site, bucket.Page, bucket.Metric)
	}

	results := s.pool.SendBatch(ctx, batch)
	defer results.Close()

	for range buckets {
		if _, err := results.Exec(); err != nil {
			return err
		}
	}
	return results.Close()
}

const selectCheckpoint = `SELECT last_event_at FROM perf_checkpoint WHERE log_group = $1`

// Checkpoint returns the watermark for a log group, or zero time if the
// cleaner has never run against it.
func (s *Store) Checkpoint(ctx context.Context, logGroup string) (time.Time, error) {
	var at time.Time
	err := s.pool.QueryRow(ctx, selectCheckpoint, logGroup).Scan(&at)
	if err == pgx.ErrNoRows {
		return time.Time{}, nil
	}
	return at, err
}

const upsertCheckpoint = `
	INSERT INTO perf_checkpoint (log_group, last_event_at, updated_at)
	VALUES ($1, $2, now())
	ON CONFLICT (log_group) DO UPDATE SET
	    last_event_at = GREATEST(perf_checkpoint.last_event_at, EXCLUDED.last_event_at),
	    updated_at = now()`

// SaveCheckpoint advances the watermark. GREATEST guards against a late
// batch pulling it backwards, which would make the poller re-read forever.
func (s *Store) SaveCheckpoint(ctx context.Context, logGroup string, at time.Time) error {
	_, err := s.pool.Exec(ctx, upsertCheckpoint, logGroup, at)
	return err
}

const deleteOldEvents = `DELETE FROM perf_events WHERE occurred_at < $1`

// PruneEvents drops detail rows past their retention. The rollups they were
// folded into stay, so history survives without the row count growing
// without bound.
func (s *Store) PruneEvents(ctx context.Context, before time.Time) (int64, error) {
	tag, err := s.pool.Exec(ctx, deleteOldEvents, before)
	if err != nil {
		return 0, err
	}
	return tag.RowsAffected(), nil
}
