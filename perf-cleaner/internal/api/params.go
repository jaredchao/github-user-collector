package api

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

var errBadRange = errors.New("时间范围非法")

// Bucket widths the API will pick from, coarsest last. Anything finer than a
// minute is pointless — the rollups themselves are per-minute.
var bucketLadder = []int{60, 300, 900, 1800, 3600, 7200, 6 * 3600, 86400}

// targetPoints is how many points a chart should end up with. Enough to see
// a shape, few enough to stay readable and to keep the payload small.
const targetPoints = 120

// PickBucketSeconds chooses the smallest bucket that keeps a span under
// targetPoints, so a one-hour view is per-minute and a 30-day view is daily
// without the caller having to think about it.
func PickBucketSeconds(span time.Duration) int {
	seconds := int(span.Seconds())
	for _, width := range bucketLadder {
		if seconds/width <= targetPoints {
			return width
		}
	}
	return bucketLadder[len(bucketLadder)-1]
}

// TimeRange resolves the from/to pair. Callers may pass explicit RFC3339
// timestamps, or a relative window such as range=24h, which is what the
// dashboard's range selector sends.
func TimeRange(query url.Values, now time.Time) (time.Time, time.Time, error) {
	if relative := query.Get("range"); relative != "" {
		span, err := ParseSpan(relative)
		if err != nil || span <= 0 {
			return time.Time{}, time.Time{}, fmt.Errorf("%w: range=%s", errBadRange, relative)
		}
		if span > 90*24*time.Hour {
			return time.Time{}, time.Time{}, fmt.Errorf("%w: 最长 90d", errBadRange)
		}
		return now.Add(-span), now, nil
	}

	from, err := parseTime(query.Get("from"))
	if err != nil {
		return time.Time{}, time.Time{}, err
	}
	to, err := parseTime(query.Get("to"))
	if err != nil {
		return time.Time{}, time.Time{}, err
	}

	// Default window when nothing was asked for.
	if from.IsZero() && to.IsZero() {
		return now.Add(-24 * time.Hour), now, nil
	}
	if from.IsZero() {
		from = to.Add(-24 * time.Hour)
	}
	if to.IsZero() {
		to = now
	}
	if !from.Before(to) {
		return time.Time{}, time.Time{}, fmt.Errorf("%w: from 必须早于 to", errBadRange)
	}
	return from, to, nil
}

// ParseSpan reads a relative window such as 30m, 24h or 7d.
//
// time.ParseDuration covers everything up to hours but rejects "d", and a
// day is the unit a dashboard range selector naturally speaks in — "7d" has
// to work, and writing it as "168h" is nobody's idea of an API.
func ParseSpan(value string) (time.Duration, error) {
	if days, found := strings.CutSuffix(value, "d"); found {
		count, err := strconv.ParseFloat(days, 64)
		if err != nil {
			return 0, fmt.Errorf("%w: %s", errBadRange, value)
		}
		return time.Duration(count * float64(24*time.Hour)), nil
	}

	span, err := time.ParseDuration(value)
	if err != nil {
		return 0, fmt.Errorf("%w: %s", errBadRange, value)
	}
	return span, nil
}

func parseTime(value string) (time.Time, error) {
	if value == "" {
		return time.Time{}, nil
	}
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("%w: %s 不是 RFC3339 时间", errBadRange, value)
	}
	return parsed.UTC(), nil
}

// Metrics the API will serve. An unknown metric is rejected rather than
// passed to the database, which would just return an empty series and look
// like "no data" instead of "you typed it wrong".
var knownMetrics = map[string]bool{
	"LCP": true, "FCP": true, "CLS": true, "INP": true, "TTFB": true,
	"RESOURCE": true, "LONGTASK": true, "CUSTOM": true, "ERROR": true,
}

func validMetric(metric string) bool {
	return knownMetrics[metric]
}

// clampLimit keeps a caller-supplied row count inside sane bounds.
func clampLimit(raw string, fallback, max int) int {
	if raw == "" {
		return fallback
	}
	var value int
	if _, err := fmt.Sscanf(raw, "%d", &value); err != nil || value <= 0 {
		return fallback
	}
	if value > max {
		return max
	}
	return value
}
