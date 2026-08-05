// Package clean turns raw SDK log lines into rows the database can trust.
//
// The ingest Lambda already validated everything it wrote, so this is the
// second line of defence, not the first. It exists because the log group is
// a separate system boundary: lines can arrive from an older SDK, from a
// replay of an old stream, or from a future ingest version, and the cleaner
// must never let any of those corrupt an aggregate.
package clean

import "time"

// SchemaVersion is the contract this cleaner understands. Lines carrying
// anything else are rejected rather than guessed at.
const SchemaVersion = 1

// Raw mirrors one JSON line in the log group, as written by perf-ingest.
type Raw struct {
	V       int            `json:"v"`
	SDK     string         `json:"sdk"`
	Site    string         `json:"site"`
	Session string         `json:"session"`
	Page    string         `json:"page"`
	UA      string         `json:"ua"`
	Conn    string         `json:"conn"`
	ID      string         `json:"id"`
	Name    string         `json:"name"`
	Value   float64        `json:"value"`
	Rating  string         `json:"rating"`
	At      int64          `json:"at"`
	Attrs   map[string]any `json:"attrs"`
}

// Event is a cleaned sample, ready to be inserted.
type Event struct {
	EventID    string
	Site       string
	Page       string
	SessionID  string
	Metric     string
	Value      float64
	Rating     string
	Device     string
	Browser    string
	Connection string
	Attrs      map[string]any
	OccurredAt time.Time
}

// Bucket is the minute an event rolls up into. Aggregates are recomputed per
// bucket, so the poller collects these as it cleans.
type Bucket struct {
	Minute time.Time
	Site   string
	Page   string
	Metric string
}

// Bucket returns the rollup key this event belongs to.
func (e Event) Bucket() Bucket {
	return Bucket{
		Minute: e.OccurredAt.UTC().Truncate(time.Minute),
		Site:   e.Site,
		Page:   e.Page,
		Metric: e.Metric,
	}
}
