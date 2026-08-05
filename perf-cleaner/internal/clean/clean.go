package clean

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode/utf8"
)

// Rejection reasons. They are returned rather than logged inside the cleaner
// so the poller can count them by kind — a sudden spike in one reason is how
// a broken SDK release announces itself.
var (
	ErrMalformed     = errors.New("不是合法的 JSON 行")
	ErrSchema        = errors.New("schema 版本不支持")
	ErrMissingField  = errors.New("必填字段缺失")
	ErrUnknownMetric = errors.New("未知指标")
	ErrOutOfRange    = errors.New("数值超出合理范围")
	ErrBot           = errors.New("来自爬虫")
)

// Per-metric sanity ceilings. A value above these is not a slow page, it is
// a broken measurement: keeping it would drag a percentile somewhere no real
// user ever was.
var maxValues = map[string]float64{
	"LCP":      120_000,
	"FCP":      120_000,
	"TTFB":     120_000,
	"INP":      60_000,
	"LONGTASK": 60_000,
	"RESOURCE": 300_000,
	"CLS":      10,
	"CUSTOM":   3_600_000,
	"ERROR":    1_000,
}

var validRatings = map[string]bool{
	"good":              true,
	"needs-improvement": true,
	"poor":              true,
}

const (
	maxPageLength    = 200
	maxSessionLength = 64
	maxEventIDLength = 64
	maxSiteLength    = 64
)

// Parse cleans one raw log line. The window bounds reject events whose
// timestamp cannot belong to this pipeline at all — a replayed stream from
// last month would otherwise rewrite aggregates that are already correct.
func Parse(line []byte, now time.Time, maxAge time.Duration) (Event, error) {
	var raw Raw
	if err := json.Unmarshal(line, &raw); err != nil {
		return Event{}, fmt.Errorf("%w: %v", ErrMalformed, err)
	}
	return Clean(raw, now, maxAge)
}

// Clean applies every rule to an already-decoded line.
func Clean(raw Raw, now time.Time, maxAge time.Duration) (Event, error) {
	if raw.V != SchemaVersion {
		return Event{}, fmt.Errorf("%w: v=%d", ErrSchema, raw.V)
	}

	site := truncate(strings.TrimSpace(raw.Site), maxSiteLength)
	page := truncate(strings.TrimSpace(raw.Page), maxPageLength)
	session := truncate(strings.TrimSpace(raw.Session), maxSessionLength)
	eventID := truncate(strings.TrimSpace(raw.ID), maxEventIDLength)
	if site == "" || page == "" || session == "" || eventID == "" {
		return Event{}, ErrMissingField
	}

	metric := strings.ToUpper(strings.TrimSpace(raw.Name))
	ceiling, known := maxValues[metric]
	if !known {
		return Event{}, fmt.Errorf("%w: %s", ErrUnknownMetric, metric)
	}

	if math.IsNaN(raw.Value) || math.IsInf(raw.Value, 0) || raw.Value < 0 || raw.Value > ceiling {
		return Event{}, fmt.Errorf("%w: %s=%v", ErrOutOfRange, metric, raw.Value)
	}

	// Synthetic traffic measures the crawler's machine, not a user's, and it
	// is disproportionately fast — leaving it in makes every page look better
	// than it is.
	if IsBot(raw.UA) {
		return Event{}, ErrBot
	}

	occurred := time.UnixMilli(raw.At).UTC()
	if occurred.Before(now.Add(-maxAge)) || occurred.After(now.Add(5*time.Minute)) {
		return Event{}, fmt.Errorf("%w: at=%s", ErrOutOfRange, occurred.Format(time.RFC3339))
	}

	rating := strings.TrimSpace(raw.Rating)
	if !validRatings[rating] {
		// A rating is derived, not observed: recovering it costs nothing and
		// is better than dropping an otherwise good sample.
		rating = rate(metric, raw.Value)
	}

	attrs := sanitizeAttrs(raw.Attrs)

	device, browser := ParseUserAgent(raw.UA)

	return Event{
		EventID:    eventID,
		Site:       site,
		Page:       page,
		SessionID:  session,
		Metric:     metric,
		Value:      raw.Value,
		Rating:     rating,
		Device:     device,
		Browser:    browser,
		Connection: fallback(truncate(raw.Conn, 32), "unknown"),
		Attrs:      attrs,
		OccurredAt: occurred,
	}, nil
}

// truncate bounds a string and strips what PostgreSQL cannot store.
//
// text columns reject U+0000 outright, and a single such byte anywhere in a
// batch fails the whole insert — one hostile beacon would stall the pipeline
// for every well-behaved visitor. Other control characters are dropped too:
// they render as garbage in the dashboard and carry no signal.
func truncate(s string, max int) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == 0 || (r < 0x20 && r != '\t') || r == 0x7f {
			return -1
		}
		return r
	}, s)

	if len(cleaned) <= max {
		return cleaned
	}

	// Cutting mid-rune would leave invalid UTF-8, which pgx rejects as well.
	cut := max
	for cut > 0 && !utf8.RuneStart(cleaned[cut]) {
		cut--
	}
	return cleaned[:cut]
}

const (
	maxAttrKeys        = 12
	maxAttrKeyLength   = 40
	maxAttrValueLength = 200
)

// sanitizeAttrs bounds the free-form attribute bag. jsonb rejects U+0000 the
// same way text does, so keys and values go through truncate as well.
//
// A nil result would be written as SQL NULL; the column is NOT NULL with a
// '{}' default, so an empty map is returned instead.
func sanitizeAttrs(raw map[string]any) map[string]any {
	attrs := make(map[string]any, len(raw))
	for key, value := range raw {
		if len(attrs) >= maxAttrKeys {
			break
		}
		safeKey := truncate(key, maxAttrKeyLength)
		if safeKey == "" {
			continue
		}
		switch typed := value.(type) {
		case string:
			attrs[safeKey] = truncate(typed, maxAttrValueLength)
		case float64, bool:
			attrs[safeKey] = typed
		default:
			// Nested structures are dropped: they are the part of a payload
			// whose size has no natural bound.
		}
	}
	return attrs
}

func fallback(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
