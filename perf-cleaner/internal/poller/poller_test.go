package poller

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs/types"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/clean"
)

var now = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

// --- fakes -----------------------------------------------------------------

type fakeLogs struct {
	// pages are returned in order; every page but the last carries a token.
	pages    [][]types.FilteredLogEvent
	calls    []cloudwatchlogs.FilterLogEventsInput
	err      error
	nextCall int
}

func (f *fakeLogs) FilterLogEvents(_ context.Context, in *cloudwatchlogs.FilterLogEventsInput,
	_ ...func(*cloudwatchlogs.Options)) (*cloudwatchlogs.FilterLogEventsOutput, error) {
	if f.err != nil {
		return nil, f.err
	}
	f.calls = append(f.calls, *in)

	index := f.nextCall
	f.nextCall++
	if index >= len(f.pages) {
		return &cloudwatchlogs.FilterLogEventsOutput{}, nil
	}

	out := &cloudwatchlogs.FilterLogEventsOutput{Events: f.pages[index]}
	if index < len(f.pages)-1 {
		out.NextToken = aws.String("page-" + string(rune('a'+index)))
	}
	return out, nil
}

type fakeSink struct {
	events      []clean.Event
	buckets     []clean.Bucket
	checkpoint  time.Time
	saved       []time.Time
	pruneBefore []time.Time
	// Event ids already stored, so the fake dedupes like the real table does.
	stored     map[string]bool
	insertErr  error
	pruneErr   error
	insertCall int
}

func newFakeSink() *fakeSink {
	return &fakeSink{stored: map[string]bool{}}
}

func (f *fakeSink) InsertEvents(_ context.Context, events []clean.Event) (int, error) {
	f.insertCall++
	if f.insertErr != nil {
		return 0, f.insertErr
	}
	inserted := 0
	for _, event := range events {
		f.events = append(f.events, event)
		if !f.stored[event.EventID] {
			f.stored[event.EventID] = true
			inserted++
		}
	}
	return inserted, nil
}

func (f *fakeSink) RecomputeRollups(_ context.Context, buckets []clean.Bucket) error {
	f.buckets = append(f.buckets, buckets...)
	return nil
}

func (f *fakeSink) Checkpoint(context.Context, string) (time.Time, error) {
	return f.checkpoint, nil
}

func (f *fakeSink) SaveCheckpoint(_ context.Context, _ string, at time.Time) error {
	f.saved = append(f.saved, at)
	f.checkpoint = at
	return nil
}

func (f *fakeSink) PruneEvents(_ context.Context, before time.Time) (int64, error) {
	if f.pruneErr != nil {
		return 0, f.pruneErr
	}
	f.pruneBefore = append(f.pruneBefore, before)
	return 3, nil
}

// --- helpers ---------------------------------------------------------------

func line(t *testing.T, id string, at time.Time, overrides func(*clean.Raw)) types.FilteredLogEvent {
	t.Helper()
	raw := clean.Raw{
		V: 1, SDK: "perf-sdk@1.0.0", Site: "demo", Session: "s-1", Page: "/",
		UA: "Mozilla/5.0 (Macintosh) Chrome/131.0 Safari/537.36", Conn: "4g",
		ID: id, Name: "LCP", Value: 1500, Rating: "good", At: at.UnixMilli(),
	}
	if overrides != nil {
		overrides(&raw)
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		t.Fatal(err)
	}
	return types.FilteredLogEvent{Message: aws.String(string(encoded)), Timestamp: aws.Int64(at.UnixMilli())}
}

func newPoller(logs LogsAPI, sink Sink) *Poller {
	p := New(logs, sink, Config{LogGroup: "/perf/raw"})
	p.now = func() time.Time { return now }
	return p
}

// --- tests -----------------------------------------------------------------

func TestRunOnceStoresCleanedEvents(t *testing.T) {
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{
		line(t, "e-1", now.Add(-2*time.Minute), nil),
		line(t, "e-2", now.Add(-time.Minute), nil),
	}}}
	sink := newFakeSink()

	stats, err := newPoller(logs, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatalf("期望成功，得到 %v", err)
	}

	if stats.Scanned != 2 || stats.Inserted != 2 || stats.Cleaned != 2 {
		t.Errorf("统计不对: %+v", stats)
	}
	if len(sink.events) != 2 {
		t.Errorf("期望写入 2 条，实际 %d", len(sink.events))
	}
}

func TestRunOnceUsesInitialLookbackWithoutCheckpoint(t *testing.T) {
	logs := &fakeLogs{}
	sink := newFakeSink()

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	want := now.Add(-time.Hour).UnixMilli()
	if got := aws.ToInt64(logs.calls[0].StartTime); got != want {
		t.Errorf("首次拉取起点期望 %d，得到 %d", want, got)
	}
}

// Log delivery is not strictly ordered, so the last seconds of a window can
// still gain events after it was read. The overlap is what stops them from
// being lost forever.
func TestRunOnceRewindsByTheOverlapWindow(t *testing.T) {
	logs := &fakeLogs{}
	sink := newFakeSink()
	sink.checkpoint = now.Add(-10 * time.Minute)

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	want := now.Add(-12 * time.Minute).UnixMilli()
	if got := aws.ToInt64(logs.calls[0].StartTime); got != want {
		t.Errorf("期望回退 2 分钟到 %d，得到 %d", want, got)
	}
}

// The overlap re-reads lines that were already stored. They must be counted
// as duplicates, not inserted twice.
func TestRunOnceCountsReReadEventsAsDuplicates(t *testing.T) {
	event := line(t, "e-1", now.Add(-time.Minute), nil)
	sink := newFakeSink()

	first := &fakeLogs{pages: [][]types.FilteredLogEvent{{event}}}
	if _, err := newPoller(first, sink).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	second := &fakeLogs{pages: [][]types.FilteredLogEvent{{event}}}
	stats, err := newPoller(second, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if stats.Inserted != 0 || stats.Duplicates != 1 {
		t.Errorf("期望 0 新增 1 重复，得到 %+v", stats)
	}
}

func TestRunOncePagesThroughEveryToken(t *testing.T) {
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{
		{line(t, "e-1", now.Add(-3*time.Minute), nil)},
		{line(t, "e-2", now.Add(-2*time.Minute), nil)},
		{line(t, "e-3", now.Add(-time.Minute), nil)},
	}}
	sink := newFakeSink()

	stats, err := newPoller(logs, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if stats.Scanned != 3 {
		t.Errorf("期望扫描 3 条，得到 %d", stats.Scanned)
	}
	if len(logs.calls) != 3 {
		t.Errorf("期望翻 3 页，实际调用 %d 次", len(logs.calls))
	}
	if logs.calls[1].NextToken == nil {
		t.Error("第二次调用应带上翻页 token")
	}
}

func TestRunOnceAdvancesCheckpointToTheNewestEvent(t *testing.T) {
	newest := now.Add(-time.Minute)
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{
		line(t, "e-1", now.Add(-5*time.Minute), nil),
		line(t, "e-2", newest, nil),
		line(t, "e-3", now.Add(-3*time.Minute), nil),
	}}}
	sink := newFakeSink()

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(sink.saved) != 1 || !sink.saved[0].Equal(newest) {
		t.Errorf("checkpoint 应推进到最新事件时间，得到 %v", sink.saved)
	}
}

// A window with nothing usable in it must leave the watermark alone, or the
// next poll would skip whatever arrives late in that same window.
func TestRunOnceLeavesCheckpointAloneWhenNothingLands(t *testing.T) {
	logs := &fakeLogs{}
	sink := newFakeSink()
	sink.checkpoint = now.Add(-5 * time.Minute)

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	if len(sink.saved) != 0 {
		t.Errorf("不应保存 checkpoint，得到 %v", sink.saved)
	}
}

func TestRunOnceCountsRejectionsByReason(t *testing.T) {
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{
		line(t, "ok", now.Add(-time.Minute), nil),
		line(t, "bot", now.Add(-time.Minute), func(r *clean.Raw) { r.UA = "Googlebot/2.1" }),
		line(t, "metric", now.Add(-time.Minute), func(r *clean.Raw) { r.Name = "NOPE" }),
		line(t, "range", now.Add(-time.Minute), func(r *clean.Raw) { r.Value = -5 }),
		line(t, "schema", now.Add(-time.Minute), func(r *clean.Raw) { r.V = 99 }),
		{Message: aws.String("{broken")},
	}}}
	sink := newFakeSink()

	stats, err := newPoller(logs, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if stats.Scanned != 6 || stats.Inserted != 1 {
		t.Errorf("统计不对: %+v", stats)
	}
	want := map[string]int{"爬虫流量": 1, "未知指标": 1, "超出范围": 1, "版本不符": 1, "格式非法": 1}
	for reason, count := range want {
		if stats.Rejected[reason] != count {
			t.Errorf("%s 期望 %d，得到 %d", reason, count, stats.Rejected[reason])
		}
	}
	if stats.TotalRejected() != 5 {
		t.Errorf("丢弃总数期望 5，得到 %d", stats.TotalRejected())
	}
}

// A busy minute produces hundreds of events but must be recomputed once.
func TestRunOnceDeduplicatesRollupBuckets(t *testing.T) {
	minute := now.Add(-2 * time.Minute)
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{
		line(t, "e-1", minute, nil),
		line(t, "e-2", minute.Add(10*time.Second), nil),
		line(t, "e-3", minute.Add(30*time.Second), nil),
		// Different page, same minute: that is a second bucket.
		line(t, "e-4", minute, func(r *clean.Raw) { r.Page = "/other" }),
		// Different metric, same minute and page: a third.
		line(t, "e-5", minute, func(r *clean.Raw) { r.Name = "CLS"; r.Value = 0.05 }),
	}}}
	sink := newFakeSink()

	stats, err := newPoller(logs, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatal(err)
	}

	if stats.Buckets != 3 || len(sink.buckets) != 3 {
		t.Errorf("期望 3 个待重算的桶，得到 stats=%d sink=%d", stats.Buckets, len(sink.buckets))
	}
}

func TestRunOnceFlushesInBatches(t *testing.T) {
	events := make([]types.FilteredLogEvent, 0, 12)
	for i := range 12 {
		events = append(events, line(t, string(rune('a'+i)), now.Add(-time.Duration(i)*time.Second), nil))
	}
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{events}}
	sink := newFakeSink()

	p := New(logs, sink, Config{LogGroup: "/perf/raw", FlushSize: 5})
	p.now = func() time.Time { return now }

	if _, err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}

	// 12 events at a flush size of 5: one flush when the buffer fills, then
	// the final flush of the remainder.
	if sink.insertCall < 2 {
		t.Errorf("期望分批写入，实际只调用 %d 次", sink.insertCall)
	}
	if len(sink.events) != 12 {
		t.Errorf("期望写入 12 条，实际 %d", len(sink.events))
	}
}

// If the checkpoint moved before the rows were stored, a crash in between
// would lose them silently. Failing the cycle leaves the watermark where it
// was, so the next run reads the same window again.
func TestRunOnceDoesNotAdvanceCheckpointWhenInsertFails(t *testing.T) {
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{line(t, "e-1", now.Add(-time.Minute), nil)}}}
	sink := newFakeSink()
	sink.insertErr = errors.New("数据库不可用")

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err == nil {
		t.Fatal("期望返回错误")
	}
	if len(sink.saved) != 0 {
		t.Errorf("失败时不应推进 checkpoint，得到 %v", sink.saved)
	}
}

func TestRunOncePropagatesFilterError(t *testing.T) {
	logs := &fakeLogs{err: errors.New("throttled")}
	sink := newFakeSink()

	if _, err := newPoller(logs, sink).RunOnce(context.Background()); err == nil {
		t.Fatal("期望返回错误")
	}
}

func TestPruneRunsOncePerInterval(t *testing.T) {
	logs := &fakeLogs{}
	sink := newFakeSink()
	p := New(logs, sink, Config{LogGroup: "/perf/raw", PruneInterval: time.Hour})

	clock := now
	p.now = func() time.Time { return clock }

	if _, err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	clock = clock.Add(10 * time.Minute)
	if _, err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sink.pruneBefore) != 1 {
		t.Fatalf("间隔内不应重复清理，得到 %d 次", len(sink.pruneBefore))
	}

	clock = clock.Add(time.Hour)
	if _, err := p.RunOnce(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(sink.pruneBefore) != 2 {
		t.Errorf("超过间隔应再次清理，得到 %d 次", len(sink.pruneBefore))
	}
	if want := clock.Add(-7 * 24 * time.Hour); !sink.pruneBefore[1].Equal(want) {
		t.Errorf("清理水位期望 %s，得到 %s", want, sink.pruneBefore[1])
	}
}

// Retention is housekeeping. A cycle that already stored data must not be
// reported as failed because the delete had trouble.
func TestPruneFailureDoesNotFailTheCycle(t *testing.T) {
	logs := &fakeLogs{pages: [][]types.FilteredLogEvent{{line(t, "e-1", now.Add(-time.Minute), nil)}}}
	sink := newFakeSink()
	sink.pruneErr = errors.New("锁等待超时")

	stats, err := newPoller(logs, sink).RunOnce(context.Background())
	if err != nil {
		t.Fatalf("清理失败不应让整轮失败: %v", err)
	}
	if stats.Inserted != 1 {
		t.Errorf("数据仍应入库，得到 %+v", stats)
	}
	if len(sink.saved) != 1 {
		t.Error("checkpoint 仍应推进")
	}
}

func TestRunStopsWhenContextIsCancelled(t *testing.T) {
	logs := &fakeLogs{}
	sink := newFakeSink()
	p := New(logs, sink, Config{LogGroup: "/perf/raw", Interval: time.Hour})
	p.now = func() time.Time { return now }

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		p.Run(ctx)
		close(done)
	}()

	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Run 未在取消后退出")
	}
}
