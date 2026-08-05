package clean

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

var now = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

const maxAge = 7 * 24 * time.Hour

func validRaw() Raw {
	return Raw{
		V:       1,
		SDK:     "perf-sdk@1.0.0",
		Site:    "demo",
		Session: "s-1",
		Page:    "/users/:id",
		UA:      "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
		Conn:    "4g",
		ID:      "e-1",
		Name:    "LCP",
		Value:   1800,
		Rating:  "good",
		At:      now.UnixMilli(),
		Attrs:   map[string]any{"element": "img#hero"},
	}
}

func TestCleanAcceptsValidRecord(t *testing.T) {
	event, err := Clean(validRaw(), now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}

	if event.EventID != "e-1" || event.Site != "demo" || event.Metric != "LCP" {
		t.Errorf("字段不对: %+v", event)
	}
	if event.Device != "desktop" || event.Browser != "Chrome" {
		t.Errorf("UA 解析不对: device=%s browser=%s", event.Device, event.Browser)
	}
	if !event.OccurredAt.Equal(now) {
		t.Errorf("时间不对: %s", event.OccurredAt)
	}
}

func TestCleanRejections(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*Raw)
		want   error
	}{
		{"版本不符", func(r *Raw) { r.V = 2 }, ErrSchema},
		{"缺 site", func(r *Raw) { r.Site = "  " }, ErrMissingField},
		{"缺 page", func(r *Raw) { r.Page = "" }, ErrMissingField},
		{"缺 session", func(r *Raw) { r.Session = "" }, ErrMissingField},
		{"缺 id", func(r *Raw) { r.ID = "" }, ErrMissingField},
		{"未知指标", func(r *Raw) { r.Name = "MADE_UP" }, ErrUnknownMetric},
		{"负值", func(r *Raw) { r.Value = -1 }, ErrOutOfRange},
		{"LCP 超上限", func(r *Raw) { r.Value = 200_000 }, ErrOutOfRange},
		{"CLS 超上限", func(r *Raw) { r.Name = "CLS"; r.Value = 50 }, ErrOutOfRange},
		{"时间太旧", func(r *Raw) { r.At = now.Add(-30 * 24 * time.Hour).UnixMilli() }, ErrOutOfRange},
		{"时间在未来", func(r *Raw) { r.At = now.Add(time.Hour).UnixMilli() }, ErrOutOfRange},
		{"爬虫 UA", func(r *Raw) { r.UA = "Mozilla/5.0 (compatible; Googlebot/2.1)" }, ErrBot},
		{"无头浏览器", func(r *Raw) { r.UA = "Mozilla/5.0 HeadlessChrome/131.0" }, ErrBot},
		{"合成监控", func(r *Raw) { r.UA = "CloudWatchSynthetics/arn" }, ErrBot},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := validRaw()
			tt.mutate(&raw)

			_, err := Clean(raw, now, maxAge)
			if !errors.Is(err, tt.want) {
				t.Errorf("期望 %v，得到 %v", tt.want, err)
			}
		})
	}
}

// A rating is derived from the value, so a missing or unrecognised one can
// be rebuilt instead of costing the whole sample.
func TestCleanRepairsRating(t *testing.T) {
	tests := []struct {
		name   string
		metric string
		value  float64
		rating string
		want   string
	}{
		{"空评级按值重算", "LCP", 5000, "", "poor"},
		{"非法评级按值重算", "LCP", 1000, "excellent", "good"},
		{"中间档", "INP", 300, "", "needs-improvement"},
		{"CLS 边界算 good", "CLS", 0.1, "", "good"},
		{"无量纲指标一律 good", "CUSTOM", 999, "", "good"},
		{"合法评级原样保留", "LCP", 1000, "poor", "poor"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			raw := validRaw()
			raw.Name = tt.metric
			raw.Value = tt.value
			raw.Rating = tt.rating

			event, err := Clean(raw, now, maxAge)
			if err != nil {
				t.Fatalf("期望通过，得到 %v", err)
			}
			if event.Rating != tt.want {
				t.Errorf("期望 %s，得到 %s", tt.want, event.Rating)
			}
		})
	}
}

func TestCleanTruncatesOversizedFields(t *testing.T) {
	raw := validRaw()
	raw.Page = "/" + strings.Repeat("a", 500)
	raw.Session = strings.Repeat("s", 200)

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if len(event.Page) != maxPageLength {
		t.Errorf("page 未截断: %d", len(event.Page))
	}
	if len(event.SessionID) != maxSessionLength {
		t.Errorf("session 未截断: %d", len(event.SessionID))
	}
}

// PostgreSQL text and jsonb both reject U+0000. One such byte anywhere in a
// batch would fail the insert for every other visitor in it.
func TestCleanStripsBytesPostgresRejects(t *testing.T) {
	raw := validRaw()
	raw.Page = "/us\x00ers\x01"
	raw.Attrs = map[string]any{"el\x00ement": "im\x00g", "size": float64(12)}

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if strings.ContainsRune(event.Page, 0) || event.Page != "/users" {
		t.Errorf("page 未清洗: %q", event.Page)
	}
	if got := event.Attrs["element"]; got != "img" {
		t.Errorf("attrs 键值未清洗: %+v", event.Attrs)
	}
	if event.Attrs["size"] != float64(12) {
		t.Errorf("数值属性应保留: %+v", event.Attrs)
	}
}

// Truncation cuts by bytes, and a multi-byte rune straddling the limit would
// leave invalid UTF-8, which pgx refuses to send.
func TestCleanTruncatesOnRuneBoundaries(t *testing.T) {
	raw := validRaw()
	raw.Page = strings.Repeat("中", 100)

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if !utf8.ValidString(event.Page) {
		t.Errorf("截断产生了非法 UTF-8: %q", event.Page)
	}
	if len(event.Page) > maxPageLength {
		t.Errorf("page 超长: %d", len(event.Page))
	}
}

func TestCleanCapsAttributeCount(t *testing.T) {
	raw := validRaw()
	attrs := make(map[string]any, 40)
	for i := range 40 {
		attrs[string(rune('a'+i%26))+strings.Repeat("x", i)] = "v"
	}
	raw.Attrs = attrs

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if len(event.Attrs) > maxAttrKeys {
		t.Errorf("attrs 键数未设上限: %d", len(event.Attrs))
	}
}

func TestCleanDropsNestedAttributes(t *testing.T) {
	raw := validRaw()
	raw.Attrs = map[string]any{
		"ok":     "value",
		"nested": map[string]any{"deep": 1},
		"list":   []any{1, 2, 3},
	}

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if len(event.Attrs) != 1 || event.Attrs["ok"] != "value" {
		t.Errorf("嵌套结构应被丢弃: %+v", event.Attrs)
	}
}

func TestCleanDefaultsMissingOptionalFields(t *testing.T) {
	raw := validRaw()
	raw.Conn = ""
	raw.Attrs = nil
	raw.UA = ""

	event, err := Clean(raw, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if event.Connection != "unknown" || event.Device != "unknown" || event.Browser != "unknown" {
		t.Errorf("缺省值不对: %+v", event)
	}
	if event.Attrs == nil {
		t.Error("attrs 应为空 map 而非 nil，否则写库时是 NULL")
	}
}

func TestParseRejectsMalformedJSON(t *testing.T) {
	if _, err := Parse([]byte("{not json"), now, maxAge); !errors.Is(err, ErrMalformed) {
		t.Errorf("期望 ErrMalformed，得到 %v", err)
	}
}

func TestParseRoundTripsAnIngestLine(t *testing.T) {
	line, err := json.Marshal(validRaw())
	if err != nil {
		t.Fatal(err)
	}

	event, err := Parse(line, now, maxAge)
	if err != nil {
		t.Fatalf("期望通过，得到 %v", err)
	}
	if event.EventID != "e-1" {
		t.Errorf("解析结果不对: %+v", event)
	}
}

func TestBucketTruncatesToTheMinute(t *testing.T) {
	event := Event{
		Site:       "demo",
		Page:       "/",
		Metric:     "LCP",
		OccurredAt: time.Date(2026, 8, 5, 12, 34, 56, 789_000_000, time.UTC),
	}

	bucket := event.Bucket()
	want := time.Date(2026, 8, 5, 12, 34, 0, 0, time.UTC)
	if !bucket.Minute.Equal(want) {
		t.Errorf("期望 %s，得到 %s", want, bucket.Minute)
	}
}

// Buckets are map keys in the poller, so two events in the same minute must
// produce equal values, not merely equivalent ones.
func TestBucketIsComparable(t *testing.T) {
	base := Event{Site: "demo", Page: "/", Metric: "LCP"}
	a := base
	a.OccurredAt = time.Date(2026, 8, 5, 12, 34, 1, 0, time.UTC)
	b := base
	b.OccurredAt = time.Date(2026, 8, 5, 12, 34, 59, 0, time.UTC)

	if a.Bucket() != b.Bucket() {
		t.Error("同一分钟内的事件应落在同一个桶")
	}
}
