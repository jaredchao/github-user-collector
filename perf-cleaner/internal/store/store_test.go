package store

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/clean"
)

// These run against a real PostgreSQL because everything worth testing here
// is PostgreSQL behaviour: percentile_cont, ON CONFLICT, and an aggregate
// HAVING with no GROUP BY. Mocking the driver would only assert that the
// strings were passed through unchanged.
//
// CI provides TEST_DATABASE_URL via a postgres service container; without it
// the suite skips rather than fails, so `go test ./...` stays green on a
// machine with no database.
func testStore(t *testing.T) *Store {
	t.Helper()

	url := os.Getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("未设置 TEST_DATABASE_URL，跳过数据库集成测试")
	}

	ctx := context.Background()
	store, err := New(ctx, url)
	if err != nil {
		t.Fatalf("连接数据库失败: %v", err)
	}
	t.Cleanup(store.Close)

	applyMigration(t, store.pool)
	truncate(t, store.pool)
	return store
}

func applyMigration(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()

	// The tables are defined once, in the migration the deployment runs.
	// Re-declaring them here would let the two drift apart silently.
	path := filepath.Join("..", "..", "..", "backend", "migrations", "003_perf.sql")
	sql, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不到迁移文件 %s: %v", path, err)
	}
	if _, err := pool.Exec(context.Background(), string(sql)); err != nil {
		t.Fatalf("执行迁移失败: %v", err)
	}
}

func truncate(t *testing.T, pool *pgxpool.Pool) {
	t.Helper()
	_, err := pool.Exec(context.Background(),
		"TRUNCATE perf_events, perf_rollup_1m, perf_checkpoint")
	if err != nil {
		t.Fatalf("清空表失败: %v", err)
	}
}

var base = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

func event(id string, value float64, overrides func(*clean.Event)) clean.Event {
	e := clean.Event{
		EventID:    id,
		Site:       "demo",
		Page:       "/",
		SessionID:  "s-1",
		Metric:     "LCP",
		Value:      value,
		Rating:     "good",
		Device:     "desktop",
		Browser:    "Chrome",
		Connection: "4g",
		Attrs:      map[string]any{},
		OccurredAt: base,
	}
	if overrides != nil {
		overrides(&e)
	}
	return e
}

func TestInsertEventsIsIdempotent(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	inserted, err := store.InsertEvents(ctx, []clean.Event{event("a", 1000, nil), event("b", 2000, nil)})
	if err != nil {
		t.Fatal(err)
	}
	if inserted != 2 {
		t.Fatalf("期望写入 2 条，实际 %d", inserted)
	}

	// The poller's overlap window re-reads lines it already stored.
	again, err := store.InsertEvents(ctx, []clean.Event{event("a", 1000, nil), event("c", 3000, nil)})
	if err != nil {
		t.Fatal(err)
	}
	if again != 1 {
		t.Errorf("重复事件应被忽略，期望新增 1 条，实际 %d", again)
	}
}

func TestInsertEventsStoresAttrsAsJSON(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	attrs := map[string]any{"element": "img#hero", "bytes": float64(1234)}
	if _, err := store.InsertEvents(ctx, []clean.Event{
		event("a", 1000, func(e *clean.Event) { e.Attrs = attrs }),
	}); err != nil {
		t.Fatal(err)
	}

	var element string
	err := store.pool.QueryRow(ctx, "SELECT attrs->>'element' FROM perf_events WHERE event_id = 'a'").Scan(&element)
	if err != nil {
		t.Fatal(err)
	}
	if element != "img#hero" {
		t.Errorf("attrs 未正确入库: %q", element)
	}
}

func TestRecomputeRollupsComputesPercentiles(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	// 1..100 inside one minute, so the percentiles are known exactly.
	events := make([]clean.Event, 0, 100)
	for i := 1; i <= 100; i++ {
		rating := "good"
		if i > 90 {
			rating = "poor"
		} else if i > 70 {
			rating = "needs-improvement"
		}
		events = append(events, event(
			fmt.Sprintf("e-%d", i),
			float64(i),
			func(e *clean.Event) {
				e.Rating = rating
				e.OccurredAt = base.Add(time.Duration(i) * time.Millisecond)
			},
		))
	}
	if _, err := store.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	bucket := clean.Bucket{Minute: base.Truncate(time.Minute), Site: "demo", Page: "/", Metric: "LCP"}
	if err := store.RecomputeRollups(ctx, []clean.Bucket{bucket}); err != nil {
		t.Fatal(err)
	}

	var samples, good, ni, poor int
	var p50, p75, p95, minValue, maxValue float64
	err := store.pool.QueryRow(ctx, `
		SELECT sample_count, p50, p75, p95, min_value, max_value, good_count, ni_count, poor_count
		FROM perf_rollup_1m WHERE bucket = $1 AND site = 'demo' AND page = '/' AND metric = 'LCP'`,
		bucket.Minute).Scan(&samples, &p50, &p75, &p95, &minValue, &maxValue, &good, &ni, &poor)
	if err != nil {
		t.Fatalf("聚合行不存在: %v", err)
	}

	if samples != 100 {
		t.Errorf("样本数期望 100，得到 %d", samples)
	}
	// percentile_cont interpolates: for 1..100 the median sits at 50.5.
	if p50 != 50.5 {
		t.Errorf("p50 期望 50.5，得到 %v", p50)
	}
	if p75 != 75.25 {
		t.Errorf("p75 期望 75.25，得到 %v", p75)
	}
	if p95 != 95.05 {
		t.Errorf("p95 期望 95.05，得到 %v", p95)
	}
	if minValue != 1 || maxValue != 100 {
		t.Errorf("极值不对: min=%v max=%v", minValue, maxValue)
	}
	if good != 70 || ni != 20 || poor != 10 {
		t.Errorf("评级分布不对: good=%d ni=%d poor=%d", good, ni, poor)
	}
}

// Replaying the same window must converge on the same aggregate, not double
// the counts — this is what makes the at-least-once pipeline safe.
func TestRecomputeRollupsIsIdempotent(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if _, err := store.InsertEvents(ctx, []clean.Event{event("a", 1000, nil), event("b", 3000, nil)}); err != nil {
		t.Fatal(err)
	}
	bucket := clean.Bucket{Minute: base.Truncate(time.Minute), Site: "demo", Page: "/", Metric: "LCP"}

	for range 3 {
		if err := store.RecomputeRollups(ctx, []clean.Bucket{bucket}); err != nil {
			t.Fatal(err)
		}
	}

	var rows, samples int
	if err := store.pool.QueryRow(ctx, "SELECT count(*), max(sample_count) FROM perf_rollup_1m").Scan(&rows, &samples); err != nil {
		t.Fatal(err)
	}
	if rows != 1 || samples != 2 {
		t.Errorf("重算应收敛，得到 %d 行，样本数 %d", rows, samples)
	}
}

// A bucket whose detail rows are all gone must leave its existing aggregate
// alone rather than overwrite it with zeroes.
func TestRecomputeRollupsSkipsEmptyBuckets(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	empty := clean.Bucket{Minute: base.Truncate(time.Minute), Site: "demo", Page: "/never", Metric: "LCP"}
	if err := store.RecomputeRollups(ctx, []clean.Bucket{empty}); err != nil {
		t.Fatal(err)
	}

	var rows int
	if err := store.pool.QueryRow(ctx, "SELECT count(*) FROM perf_rollup_1m").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Errorf("空桶不应写入聚合行，得到 %d 行", rows)
	}
}

func TestCheckpointRoundTrip(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	at, err := store.Checkpoint(ctx, "/perf/raw")
	if err != nil {
		t.Fatal(err)
	}
	if !at.IsZero() {
		t.Errorf("首次应返回零值，得到 %s", at)
	}

	if err := store.SaveCheckpoint(ctx, "/perf/raw", base); err != nil {
		t.Fatal(err)
	}
	at, err = store.Checkpoint(ctx, "/perf/raw")
	if err != nil {
		t.Fatal(err)
	}
	if !at.Equal(base) {
		t.Errorf("期望 %s，得到 %s", base, at)
	}
}

// A late batch must not pull the watermark backwards, or the poller would
// re-read the same window forever.
func TestSaveCheckpointNeverGoesBackwards(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if err := store.SaveCheckpoint(ctx, "/perf/raw", base); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveCheckpoint(ctx, "/perf/raw", base.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}

	at, err := store.Checkpoint(ctx, "/perf/raw")
	if err != nil {
		t.Fatal(err)
	}
	if !at.Equal(base) {
		t.Errorf("水位被拉回了: %s", at)
	}
}

func TestPruneEventsKeepsRollups(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	old := event("old", 1000, func(e *clean.Event) { e.OccurredAt = base.Add(-30 * 24 * time.Hour) })
	if _, err := store.InsertEvents(ctx, []clean.Event{old, event("fresh", 2000, nil)}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecomputeRollups(ctx, []clean.Bucket{old.Bucket()}); err != nil {
		t.Fatal(err)
	}

	pruned, err := store.PruneEvents(ctx, base.Add(-7*24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if pruned != 1 {
		t.Errorf("期望删除 1 条，实际 %d", pruned)
	}

	var rollups int
	if err := store.pool.QueryRow(ctx, "SELECT count(*) FROM perf_rollup_1m").Scan(&rollups); err != nil {
		t.Fatal(err)
	}
	if rollups != 1 {
		t.Error("明细清理后聚合应保留")
	}
}

func TestTimeseriesReadsDetailWhenAvailable(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if _, err := store.InsertEvents(ctx, []clean.Event{
		event("a", 1000, nil),
		event("b", 3000, nil),
		event("c", 2000, func(e *clean.Event) { e.Page = "/other" }),
	}); err != nil {
		t.Fatal(err)
	}

	query := Query{
		Site:          "demo",
		Metric:        "LCP",
		From:          base.Add(-time.Hour),
		To:            base.Add(time.Hour),
		BucketSeconds: 60,
	}
	points, approx, err := store.Timeseries(ctx, query, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if approx {
		t.Error("保留期内的查询应是精确的")
	}
	if len(points) != 1 {
		t.Fatalf("期望 1 个桶，得到 %d", len(points))
	}
	if points[0].Samples != 3 {
		t.Errorf("未指定 page 时应含全部页面，得到 %d", points[0].Samples)
	}

	query.Page = "/other"
	filtered, _, err := store.Timeseries(ctx, query, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(filtered) != 1 || filtered[0].Samples != 1 {
		t.Errorf("page 过滤未生效: %+v", filtered)
	}
}

// Past the detail retention the answer comes from merged rollups, and the
// caller has to be told it is an approximation.
func TestTimeseriesFallsBackToRollups(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if _, err := store.InsertEvents(ctx, []clean.Event{event("a", 1000, nil), event("b", 3000, nil)}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecomputeRollups(ctx, []clean.Bucket{event("a", 1000, nil).Bucket()}); err != nil {
		t.Fatal(err)
	}

	query := Query{
		Site:          "demo",
		Metric:        "LCP",
		From:          base.Add(-30 * 24 * time.Hour),
		To:            base.Add(time.Hour),
		BucketSeconds: 3600,
	}
	points, approx, err := store.Timeseries(ctx, query, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if !approx {
		t.Error("跨出明细保留期应标记为近似")
	}
	if len(points) != 1 || points[0].Samples != 2 {
		t.Errorf("聚合读取不对: %+v", points)
	}

	// With one page selected each rollup row is already that page's exact
	// percentile, so nothing is being merged.
	query.Page = "/"
	_, approxSinglePage, err := store.Timeseries(ctx, query, base.Add(-24*time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if approxSinglePage {
		t.Error("指定单个页面时聚合行本身就是精确值")
	}
}

func TestSummaryGroupsByMetric(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if _, err := store.InsertEvents(ctx, []clean.Event{
		event("a", 1000, nil),
		event("b", 3000, nil),
		event("c", 0.05, func(e *clean.Event) { e.Metric = "CLS" }),
	}); err != nil {
		t.Fatal(err)
	}

	summaries, err := store.Summary(ctx, Query{Site: "demo", From: base.Add(-time.Hour), To: base.Add(time.Hour)})
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 2 {
		t.Fatalf("期望 2 个指标，得到 %d", len(summaries))
	}
	// Ordered by metric name: CLS before LCP.
	if summaries[0].Metric != "CLS" || summaries[1].Metric != "LCP" {
		t.Errorf("排序不对: %+v", summaries)
	}
	if summaries[1].Samples != 2 {
		t.Errorf("LCP 样本数期望 2，得到 %d", summaries[1].Samples)
	}
}

func TestPageBreakdownOrdersByTraffic(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	events := []clean.Event{
		// One very slow visit to a page nobody loads must not top the list.
		event("slow", 9000, func(e *clean.Event) { e.Page = "/rare" }),
	}
	for i := range 5 {
		events = append(events, event(fmt.Sprintf("busy-%d", i), 1500, func(e *clean.Event) {
			e.Page = "/busy"
		}))
	}
	if _, err := store.InsertEvents(ctx, events); err != nil {
		t.Fatal(err)
	}

	stats, err := store.PageBreakdown(ctx, Query{
		Site: "demo", Metric: "LCP", From: base.Add(-time.Hour), To: base.Add(time.Hour),
	}, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("期望 2 个页面，得到 %d", len(stats))
	}
	if stats[0].Page != "/busy" {
		t.Errorf("应按流量排序，第一位是 %s", stats[0].Page)
	}
}

func TestSitesAndPages(t *testing.T) {
	store := testStore(t)
	ctx := context.Background()

	if _, err := store.InsertEvents(ctx, []clean.Event{
		event("a", 1000, nil),
		event("b", 1000, func(e *clean.Event) { e.Site = "other"; e.Page = "/x" }),
	}); err != nil {
		t.Fatal(err)
	}

	sites, err := store.Sites(ctx, base.Add(-time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	if len(sites) != 2 || sites[0] != "demo" || sites[1] != "other" {
		t.Errorf("站点列表不对: %v", sites)
	}

	pages, err := store.Pages(ctx, "demo", base.Add(-time.Hour), 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(pages) != 1 || pages[0] != "/" {
		t.Errorf("页面列表不对: %v", pages)
	}
}
