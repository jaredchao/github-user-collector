// Package api serves the cleaned aggregates to the dashboard.
//
// It lives inside the cleaner rather than in a separate service because the
// cleaner already holds a warm connection pool to the only database that has
// this data, and the dashboard's read volume is a rounding error next to the
// ingest path.
package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/store"
)

// Reader is the read side of the store. Declared here so the handler tests
// need no database.
type Reader interface {
	Ping(ctx context.Context) error
	Timeseries(ctx context.Context, q store.Query, detailFrom time.Time) ([]store.Point, bool, error)
	PageBreakdown(ctx context.Context, q store.Query, limit int) ([]store.PageStat, error)
	Summary(ctx context.Context, q store.Query) ([]store.MetricSummary, error)
	Sites(ctx context.Context, since time.Time) ([]string, error)
	Pages(ctx context.Context, site string, since time.Time, limit int) ([]string, error)
}

type Config struct {
	// Detail retention, used to tell exact answers from approximate ones.
	DetailRetention time.Duration
	// Browser origins allowed to read. Empty means any origin.
	AllowedOrigins []string
}

type server struct {
	reader Reader
	config Config
	now    func() time.Time
}

// New returns the handler with every route mounted.
func New(reader Reader, config Config) http.Handler {
	s := &server{reader: reader, config: config, now: time.Now}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/sites", s.sites)
	mux.HandleFunc("GET /api/pages", s.pages)
	mux.HandleFunc("GET /api/summary", s.summary)
	mux.HandleFunc("GET /api/timeseries", s.timeseries)
	mux.HandleFunc("GET /api/breakdown", s.breakdown)
	return s.withCORS(mux)
}

func (s *server) health(w http.ResponseWriter, r *http.Request) {
	if err := s.reader.Ping(r.Context()); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db unavailable"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *server) sites(w http.ResponseWriter, r *http.Request) {
	since := s.now().UTC().Add(-s.config.DetailRetention)
	sites, err := s.reader.Sites(r.Context(), since)
	if err != nil {
		s.fail(w, "查询站点列表失败", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"sites": sites})
}

func (s *server) pages(w http.ResponseWriter, r *http.Request) {
	site := r.URL.Query().Get("site")
	if site == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "site 参数必填"})
		return
	}

	since := s.now().UTC().Add(-s.config.DetailRetention)
	limit := clampLimit(r.URL.Query().Get("limit"), 50, 200)
	pages, err := s.reader.Pages(r.Context(), site, since, limit)
	if err != nil {
		s.fail(w, "查询页面列表失败", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"pages": pages})
}

func (s *server) summary(w http.ResponseWriter, r *http.Request) {
	query, ok := s.parseQuery(w, r, false)
	if !ok {
		return
	}

	summaries, err := s.reader.Summary(r.Context(), query)
	if err != nil {
		s.fail(w, "查询汇总失败", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"site":    query.Site,
		"page":    query.Page,
		"from":    query.From,
		"to":      query.To,
		"metrics": summaries,
	})
}

func (s *server) timeseries(w http.ResponseWriter, r *http.Request) {
	query, ok := s.parseQuery(w, r, true)
	if !ok {
		return
	}

	detailFrom := s.now().UTC().Add(-s.config.DetailRetention)
	points, approx, err := s.reader.Timeseries(r.Context(), query, detailFrom)
	if err != nil {
		s.fail(w, "查询时间序列失败", err)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"site":          query.Site,
		"metric":        query.Metric,
		"page":          query.Page,
		"from":          query.From,
		"to":            query.To,
		"bucketSeconds": query.BucketSeconds,
		// Beyond the detail retention the percentiles are merged from
		// per-minute rollups, which is an approximation. The dashboard says
		// so on the chart rather than quietly presenting it as exact.
		"approximate": approx,
		"points":      points,
	})
}

func (s *server) breakdown(w http.ResponseWriter, r *http.Request) {
	query, ok := s.parseQuery(w, r, true)
	if !ok {
		return
	}

	limit := clampLimit(r.URL.Query().Get("limit"), 10, 50)
	stats, err := s.reader.PageBreakdown(r.Context(), query, limit)
	if err != nil {
		s.fail(w, "查询页面分布失败", err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"site":   query.Site,
		"metric": query.Metric,
		"pages":  stats,
	})
}

// parseQuery validates the filters every read shares. requireMetric is false
// for the summary, which reports on all metrics at once.
func (s *server) parseQuery(w http.ResponseWriter, r *http.Request, requireMetric bool) (store.Query, bool) {
	values := r.URL.Query()

	site := values.Get("site")
	if site == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "site 参数必填"})
		return store.Query{}, false
	}

	metric := strings.ToUpper(values.Get("metric"))
	if requireMetric && !validMetric(metric) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "metric 参数缺失或不支持"})
		return store.Query{}, false
	}

	from, to, err := TimeRange(values, s.now().UTC())
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return store.Query{}, false
	}

	return store.Query{
		Site:          site,
		Metric:        metric,
		Page:          values.Get("page"),
		From:          from,
		To:            to,
		BucketSeconds: PickBucketSeconds(to.Sub(from)),
	}, true
}

// fail keeps the database's error text out of the response while leaving it
// in the service log, where it belongs.
func (s *server) fail(w http.ResponseWriter, message string, err error) {
	log.Printf("%s: %v", message, err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": message})
}

func (s *server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if allowed := s.allowOrigin(origin); allowed != "" {
			w.Header().Set("Access-Control-Allow-Origin", allowed)
			if allowed != "*" {
				w.Header().Set("Vary", "Origin")
			}
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *server) allowOrigin(origin string) string {
	if len(s.config.AllowedOrigins) == 0 {
		return "*"
	}
	for _, allowed := range s.config.AllowedOrigins {
		if origin == allowed {
			return origin
		}
	}
	return ""
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
