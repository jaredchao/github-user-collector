package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/store"
)

type fakeReader struct {
	points     []store.Point
	approx     bool
	pages      []store.PageStat
	summaries  []store.MetricSummary
	sites      []string
	pageNames  []string
	err        error
	pingErr    error
	lastQuery  store.Query
	lastDetail time.Time
	lastLimit  int
}

func (f *fakeReader) Ping(context.Context) error { return f.pingErr }

func (f *fakeReader) Timeseries(_ context.Context, q store.Query, detailFrom time.Time) ([]store.Point, bool, error) {
	f.lastQuery, f.lastDetail = q, detailFrom
	return f.points, f.approx, f.err
}

func (f *fakeReader) PageBreakdown(_ context.Context, q store.Query, limit int) ([]store.PageStat, error) {
	f.lastQuery, f.lastLimit = q, limit
	return f.pages, f.err
}

func (f *fakeReader) Summary(_ context.Context, q store.Query) ([]store.MetricSummary, error) {
	f.lastQuery = q
	return f.summaries, f.err
}

func (f *fakeReader) Sites(context.Context, time.Time) ([]string, error) {
	return f.sites, f.err
}

func (f *fakeReader) Pages(_ context.Context, _ string, _ time.Time, limit int) ([]string, error) {
	f.lastLimit = limit
	return f.pageNames, f.err
}

func newServer(reader Reader, origins ...string) http.Handler {
	handler := New(reader, Config{DetailRetention: 7 * 24 * time.Hour, AllowedOrigins: origins})
	// New returns the wrapped handler, so the clock is pinned by reaching
	// through the same constructor the routes were built with.
	return handler
}

func get(t *testing.T, handler http.Handler, target string, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, target, nil)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	return rec
}

func decode[T any](t *testing.T, body io.Reader) T {
	t.Helper()
	var out T
	if err := json.NewDecoder(body).Decode(&out); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	return out
}

func TestHealth(t *testing.T) {
	reader := &fakeReader{}
	rec := get(t, newServer(reader), "/health", nil)
	if rec.Code != http.StatusOK {
		t.Errorf("期望 200，得到 %d", rec.Code)
	}

	reader.pingErr = errors.New("connection refused")
	rec = get(t, newServer(reader), "/health", nil)
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("数据库不可用时期望 503，得到 %d", rec.Code)
	}
}

func TestTimeseriesRequiresSiteAndMetric(t *testing.T) {
	tests := []struct {
		name   string
		target string
	}{
		{"缺 site", "/api/timeseries?metric=LCP"},
		{"缺 metric", "/api/timeseries?site=demo"},
		{"metric 不支持", "/api/timeseries?site=demo&metric=NOPE"},
		{"range 非法", "/api/timeseries?site=demo&metric=LCP&range=abc"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := get(t, newServer(&fakeReader{}), tt.target, nil)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("期望 400，得到 %d", rec.Code)
			}
		})
	}
}

func TestTimeseriesPassesFiltersThrough(t *testing.T) {
	reader := &fakeReader{points: []store.Point{{Samples: 3, P75: 1800}}}

	rec := get(t, newServer(reader), "/api/timeseries?site=demo&metric=lcp&page=/users/:id&range=6h", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d: %s", rec.Code, rec.Body)
	}

	if reader.lastQuery.Site != "demo" || reader.lastQuery.Page != "/users/:id" {
		t.Errorf("过滤条件未透传: %+v", reader.lastQuery)
	}
	// A lowercase metric is normalised rather than rejected.
	if reader.lastQuery.Metric != "LCP" {
		t.Errorf("metric 应转为大写，得到 %s", reader.lastQuery.Metric)
	}
	if reader.lastQuery.BucketSeconds != PickBucketSeconds(6*time.Hour) {
		t.Errorf("桶宽应按跨度选择，得到 %d", reader.lastQuery.BucketSeconds)
	}

	body := decode[map[string]any](t, rec.Body)
	if body["approximate"] != false {
		t.Errorf("期望标记为精确，得到 %v", body["approximate"])
	}
}

// Beyond the detail retention the numbers are merged from per-minute
// rollups. Saying so is the difference between an honest chart and a
// confident wrong one.
func TestTimeseriesFlagsApproximateAnswers(t *testing.T) {
	reader := &fakeReader{approx: true}

	rec := get(t, newServer(reader), "/api/timeseries?site=demo&metric=LCP&range=30d", nil)
	body := decode[map[string]any](t, rec.Body)

	if body["approximate"] != true {
		t.Errorf("期望标记为近似，得到 %v", body["approximate"])
	}
}

func TestTimeseriesTellsTheStoreWhereDetailEnds(t *testing.T) {
	reader := &fakeReader{}
	before := time.Now().UTC().Add(-7 * 24 * time.Hour)

	get(t, newServer(reader), "/api/timeseries?site=demo&metric=LCP&range=1h", nil)

	if reader.lastDetail.Sub(before) > time.Minute {
		t.Errorf("明细保留起点不对: %s", reader.lastDetail)
	}
}

func TestSummaryDoesNotRequireAMetric(t *testing.T) {
	reader := &fakeReader{summaries: []store.MetricSummary{{Metric: "LCP", Samples: 10, P75: 2000}}}

	rec := get(t, newServer(reader), "/api/summary?site=demo&range=1h", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，得到 %d: %s", rec.Code, rec.Body)
	}
	if !strings.Contains(rec.Body.String(), `"metric":"LCP"`) {
		t.Errorf("响应缺少指标数据: %s", rec.Body)
	}
}

func TestBreakdownClampsLimit(t *testing.T) {
	reader := &fakeReader{}

	get(t, newServer(reader), "/api/breakdown?site=demo&metric=LCP&limit=9999", nil)
	if reader.lastLimit != 50 {
		t.Errorf("limit 应被收敛到 50，得到 %d", reader.lastLimit)
	}
}

func TestPagesRequiresSite(t *testing.T) {
	rec := get(t, newServer(&fakeReader{}), "/api/pages", nil)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("期望 400，得到 %d", rec.Code)
	}
}

// The database's own error text can name tables, columns and hosts; it stays
// in the service log and never reaches the browser.
func TestInternalErrorsDoNotLeakDatabaseDetail(t *testing.T) {
	log.SetOutput(io.Discard)
	defer log.SetOutput(nil)

	reader := &fakeReader{err: errors.New(`relation "perf_events" does not exist on host db-1.internal`)}
	rec := get(t, newServer(reader), "/api/timeseries?site=demo&metric=LCP", nil)

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("期望 500，得到 %d", rec.Code)
	}
	if strings.Contains(rec.Body.String(), "perf_events") || strings.Contains(rec.Body.String(), "db-1.internal") {
		t.Errorf("响应泄漏了数据库细节: %s", rec.Body)
	}
}

func TestCORS(t *testing.T) {
	t.Run("未配置时放行任意来源", func(t *testing.T) {
		rec := get(t, newServer(&fakeReader{}), "/api/sites", map[string]string{"Origin": "https://anywhere.test"})
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
			t.Errorf("期望 *，得到 %q", got)
		}
	})

	t.Run("白名单内回显来源并带 Vary", func(t *testing.T) {
		handler := newServer(&fakeReader{}, "https://dash.test")
		rec := get(t, handler, "/api/sites", map[string]string{"Origin": "https://dash.test"})

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://dash.test" {
			t.Errorf("期望回显来源，得到 %q", got)
		}
		if rec.Header().Get("Vary") != "Origin" {
			t.Error("回显来源时必须带 Vary: Origin，否则共享缓存会串站")
		}
	})

	t.Run("白名单外不放行", func(t *testing.T) {
		handler := newServer(&fakeReader{}, "https://dash.test")
		rec := get(t, handler, "/api/sites", map[string]string{"Origin": "https://evil.test"})

		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("不应放行，得到 %q", got)
		}
	})

	t.Run("预检直接返回 204", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodOptions, "/api/sites", nil)
		req.Header.Set("Origin", "https://dash.test")
		rec := httptest.NewRecorder()
		newServer(&fakeReader{}, "https://dash.test").ServeHTTP(rec, req)

		if rec.Code != http.StatusNoContent {
			t.Errorf("期望 204，得到 %d", rec.Code)
		}
		if rec.Header().Get("Access-Control-Allow-Methods") == "" {
			t.Error("预检响应缺少 Allow-Methods")
		}
	})
}
