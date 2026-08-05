package store

import (
	"context"
	"time"
)

// Query is the filter every dashboard read shares. An empty Page means
// "every page on this site".
type Query struct {
	Site   string
	Metric string
	Page   string
	From   time.Time
	To     time.Time
	// Bucket width in seconds. The API picks it from the time span so a
	// chart gets a readable number of points instead of 1440 of them.
	BucketSeconds int
}

// Point is one plotted position in a time series.
type Point struct {
	Bucket  time.Time `json:"bucket"`
	Samples int       `json:"samples"`
	P50     float64   `json:"p50"`
	P75     float64   `json:"p75"`
	P95     float64   `json:"p95"`
	Good    int       `json:"good"`
	NI      int       `json:"needsImprovement"`
	Poor    int       `json:"poor"`
}

// Percentiles are computed from the detail rows, not merged from per-minute
// aggregates: merging percentiles is arithmetically wrong, and the error
// grows exactly where the dashboard is most looked at — the slow tail.
const timeseriesFromEvents = `
	SELECT to_timestamp(floor(extract(epoch FROM occurred_at) / $5) * $5) AS bucket,
	       count(*),
	       percentile_cont(0.5)  WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.95) WITHIN GROUP (ORDER BY value),
	       count(*) FILTER (WHERE rating = 'good'),
	       count(*) FILTER (WHERE rating = 'needs-improvement'),
	       count(*) FILTER (WHERE rating = 'poor')
	FROM perf_events
	WHERE site = $1 AND metric = $2
	  AND occurred_at >= $3 AND occurred_at < $4
	  AND ($6 = '' OR page = $6)
	GROUP BY 1
	ORDER BY 1`

// Fallback for ranges older than the detail retention. Weighting each
// bucket's percentile by its sample count is an approximation, and the API
// labels the response as such rather than passing it off as exact.
const timeseriesFromRollups = `
	SELECT to_timestamp(floor(extract(epoch FROM bucket) / $5) * $5) AS b,
	       sum(sample_count)::int,
	       sum(p50 * sample_count) / nullif(sum(sample_count), 0),
	       sum(p75 * sample_count) / nullif(sum(sample_count), 0),
	       sum(p95 * sample_count) / nullif(sum(sample_count), 0),
	       sum(good_count)::int, sum(ni_count)::int, sum(poor_count)::int
	FROM perf_rollup_1m
	WHERE site = $1 AND metric = $2
	  AND bucket >= $3 AND bucket < $4
	  AND ($6 = '' OR page = $6)
	GROUP BY 1
	ORDER BY 1`

// Timeseries returns the chart series. detailFrom is the oldest timestamp
// still covered by perf_events; queries reaching further back fall back to
// the rollups and come back flagged approximate.
func (s *Store) Timeseries(ctx context.Context, q Query, detailFrom time.Time) ([]Point, bool, error) {
	query, approx := timeseriesFromEvents, false
	if q.From.Before(detailFrom) {
		query = timeseriesFromRollups
		// With a single page selected, each rollup row already is that
		// page's exact percentile — nothing is being merged.
		approx = q.Page == ""
	}

	rows, err := s.pool.Query(ctx, query, q.Site, q.Metric, q.From, q.To, q.BucketSeconds, q.Page)
	if err != nil {
		return nil, approx, err
	}
	defer rows.Close()

	points := make([]Point, 0, 128)
	for rows.Next() {
		var p Point
		if err := rows.Scan(&p.Bucket, &p.Samples, &p.P50, &p.P75, &p.P95, &p.Good, &p.NI, &p.Poor); err != nil {
			return nil, approx, err
		}
		points = append(points, p)
	}
	return points, approx, rows.Err()
}

// PageStat ranks one page within a metric.
type PageStat struct {
	Page    string  `json:"page"`
	Samples int     `json:"samples"`
	P75     float64 `json:"p75"`
	Poor    int     `json:"poor"`
}

const pageBreakdown = `
	SELECT page, count(*),
	       percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
	       count(*) FILTER (WHERE rating = 'poor')
	FROM perf_events
	WHERE site = $1 AND metric = $2 AND occurred_at >= $3 AND occurred_at < $4
	GROUP BY page
	ORDER BY 2 DESC
	LIMIT $5`

// PageBreakdown answers "which pages is this metric worst on", ordered by
// traffic so a single slow visit to an obscure page cannot top the chart.
func (s *Store) PageBreakdown(ctx context.Context, q Query, limit int) ([]PageStat, error) {
	rows, err := s.pool.Query(ctx, pageBreakdown, q.Site, q.Metric, q.From, q.To, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	stats := make([]PageStat, 0, limit)
	for rows.Next() {
		var stat PageStat
		if err := rows.Scan(&stat.Page, &stat.Samples, &stat.P75, &stat.Poor); err != nil {
			return nil, err
		}
		stats = append(stats, stat)
	}
	return stats, rows.Err()
}

// MetricSummary is one card on the dashboard's header row.
type MetricSummary struct {
	Metric  string  `json:"metric"`
	Samples int     `json:"samples"`
	P50     float64 `json:"p50"`
	P75     float64 `json:"p75"`
	P95     float64 `json:"p95"`
	Good    int     `json:"good"`
	NI      int     `json:"needsImprovement"`
	Poor    int     `json:"poor"`
}

const summary = `
	SELECT metric, count(*),
	       percentile_cont(0.5)  WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.75) WITHIN GROUP (ORDER BY value),
	       percentile_cont(0.95) WITHIN GROUP (ORDER BY value),
	       count(*) FILTER (WHERE rating = 'good'),
	       count(*) FILTER (WHERE rating = 'needs-improvement'),
	       count(*) FILTER (WHERE rating = 'poor')
	FROM perf_events
	WHERE site = $1 AND occurred_at >= $2 AND occurred_at < $3
	  AND ($4 = '' OR page = $4)
	GROUP BY metric
	ORDER BY metric`

// Summary returns one row per metric for the selected window.
func (s *Store) Summary(ctx context.Context, q Query) ([]MetricSummary, error) {
	rows, err := s.pool.Query(ctx, summary, q.Site, q.From, q.To, q.Page)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summaries := make([]MetricSummary, 0, 8)
	for rows.Next() {
		var m MetricSummary
		if err := rows.Scan(&m.Metric, &m.Samples, &m.P50, &m.P75, &m.P95, &m.Good, &m.NI, &m.Poor); err != nil {
			return nil, err
		}
		summaries = append(summaries, m)
	}
	return summaries, rows.Err()
}

const distinctSites = `
	SELECT DISTINCT site FROM perf_events WHERE occurred_at >= $1 ORDER BY site`

const distinctPages = `
	SELECT page FROM perf_events
	WHERE site = $1 AND occurred_at >= $2
	GROUP BY page
	ORDER BY count(*) DESC
	LIMIT $3`

// Sites lists the sites reporting recently, for the dashboard's selector.
func (s *Store) Sites(ctx context.Context, since time.Time) ([]string, error) {
	return s.strings(ctx, distinctSites, since)
}

// Pages lists a site's busiest pages, for the dashboard's page filter.
func (s *Store) Pages(ctx context.Context, site string, since time.Time, limit int) ([]string, error) {
	return s.strings(ctx, distinctPages, site, since, limit)
}

func (s *Store) strings(ctx context.Context, query string, args ...any) ([]string, error) {
	rows, err := s.pool.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	values := make([]string, 0, 32)
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		values = append(values, value)
	}
	return values, rows.Err()
}
