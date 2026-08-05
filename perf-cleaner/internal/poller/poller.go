// Package poller pulls raw SDK samples out of CloudWatch Logs, cleans them,
// and keeps the database aggregates current.
//
// Pulling was chosen over a subscription filter because a subscription needs
// a Kinesis stream, which bills per shard-hour whether or not anyone is
// looking at the dashboard. The cost is latency: samples show up one poll
// interval late rather than within a second.
package poller

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/clean"
)

// LogsAPI is the slice of the CloudWatch Logs client this package uses.
// Declared here so tests can supply a fake without touching AWS.
type LogsAPI interface {
	FilterLogEvents(ctx context.Context, params *cloudwatchlogs.FilterLogEventsInput,
		optFns ...func(*cloudwatchlogs.Options)) (*cloudwatchlogs.FilterLogEventsOutput, error)
}

// Sink is the database side of the poller.
type Sink interface {
	InsertEvents(ctx context.Context, events []clean.Event) (int, error)
	RecomputeRollups(ctx context.Context, buckets []clean.Bucket) error
	Checkpoint(ctx context.Context, logGroup string) (time.Time, error)
	SaveCheckpoint(ctx context.Context, logGroup string, at time.Time) error
	PruneEvents(ctx context.Context, before time.Time) (int64, error)
}

type Config struct {
	LogGroup string
	Interval time.Duration
	// How far back a first run reaches when there is no checkpoint yet.
	InitialLookback time.Duration
	// Re-read window on every poll. Log delivery is not strictly ordered by
	// timestamp, so the last few seconds of a window can still gain events
	// after it was read. Duplicates are free (event_id is the primary key);
	// missed events would be invisible forever.
	Overlap time.Duration
	// Detail rows older than this are deleted; their rollups remain.
	DetailRetention time.Duration
	// How often to run the prune, since it does not need to run every poll.
	PruneInterval time.Duration
	// Rows held in memory before a flush to the database.
	FlushSize int
}

func (c Config) withDefaults() Config {
	if c.Interval <= 0 {
		c.Interval = 30 * time.Second
	}
	if c.InitialLookback <= 0 {
		c.InitialLookback = time.Hour
	}
	if c.Overlap <= 0 {
		c.Overlap = 2 * time.Minute
	}
	if c.DetailRetention <= 0 {
		c.DetailRetention = 7 * 24 * time.Hour
	}
	if c.PruneInterval <= 0 {
		c.PruneInterval = time.Hour
	}
	if c.FlushSize <= 0 {
		c.FlushSize = 500
	}
	return c
}

type Poller struct {
	logs      LogsAPI
	sink      Sink
	config    Config
	now       func() time.Time
	lastPrune time.Time
}

func New(logs LogsAPI, sink Sink, config Config) *Poller {
	return &Poller{logs: logs, sink: sink, config: config.withDefaults(), now: time.Now}
}

// Run polls until the context is cancelled. A failed cycle is logged and
// retried on the next tick rather than killing the service: the checkpoint
// was not advanced, so nothing is lost.
func (p *Poller) Run(ctx context.Context) {
	ticker := time.NewTicker(p.config.Interval)
	defer ticker.Stop()

	for {
		stats, err := p.RunOnce(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			log.Printf("清洗轮次失败: %v", err)
		} else if stats.Scanned > 0 {
			log.Printf("清洗完成: %s", stats)
		}

		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// RunOnce performs a single poll-clean-store cycle.
func (p *Poller) RunOnce(ctx context.Context) (Stats, error) {
	stats := NewStats()
	now := p.now().UTC()

	checkpoint, err := p.sink.Checkpoint(ctx, p.config.LogGroup)
	if err != nil {
		return stats, err
	}

	start := checkpoint.Add(-p.config.Overlap)
	if checkpoint.IsZero() {
		start = now.Add(-p.config.InitialLookback)
	}

	pending := make([]clean.Event, 0, p.config.FlushSize)
	buckets := newBucketSet()
	highWater := checkpoint

	var token *string
	for {
		out, err := p.logs.FilterLogEvents(ctx, &cloudwatchlogs.FilterLogEventsInput{
			LogGroupName: aws.String(p.config.LogGroup),
			StartTime:    aws.Int64(start.UnixMilli()),
			EndTime:      aws.Int64(now.UnixMilli()),
			NextToken:    token,
		})
		if err != nil {
			return stats, err
		}

		for _, entry := range out.Events {
			if entry.Message == nil {
				continue
			}
			stats.Scanned++

			event, err := clean.Parse([]byte(*entry.Message), now, p.config.DetailRetention)
			if err != nil {
				stats.Reject(err)
				continue
			}

			pending = append(pending, event)
			buckets.add(event.Bucket())
			if event.OccurredAt.After(highWater) {
				highWater = event.OccurredAt
			}

			// Checked per event, not per page: one page can carry up to
			// 10,000 log events, and holding all of them would make FlushSize
			// meaningless as a memory bound.
			if len(pending) >= p.config.FlushSize {
				if err := p.flush(ctx, pending, &stats); err != nil {
					return stats, err
				}
				pending = pending[:0]
			}
		}

		token = out.NextToken
		if token == nil {
			break
		}
	}

	if err := p.flush(ctx, pending, &stats); err != nil {
		return stats, err
	}

	// Aggregates are refreshed before the checkpoint moves. If the process
	// dies in between, the next run re-reads the same window and recomputes
	// the same buckets — wasteful, but never wrong.
	if err := p.sink.RecomputeRollups(ctx, buckets.slice()); err != nil {
		return stats, err
	}
	stats.Buckets = buckets.len()

	if highWater.After(checkpoint) {
		if err := p.sink.SaveCheckpoint(ctx, p.config.LogGroup, highWater); err != nil {
			return stats, err
		}
	}

	pruned, err := p.maybePrune(ctx, now)
	if err != nil {
		// Retention is housekeeping; failing it must not fail the cycle that
		// already stored data successfully.
		log.Printf("清理过期明细失败: %v", err)
	}
	stats.Pruned = pruned

	return stats, nil
}

func (p *Poller) flush(ctx context.Context, events []clean.Event, stats *Stats) error {
	if len(events) == 0 {
		return nil
	}
	inserted, err := p.sink.InsertEvents(ctx, events)
	if err != nil {
		return err
	}
	stats.Cleaned += len(events)
	stats.Inserted += inserted
	// The difference is the at-least-once overlap doing its job.
	stats.Duplicates += len(events) - inserted
	return nil
}

// maybePrune runs the retention delete at most once per PruneInterval and
// reports how many rows it removed; zero means it was not due yet.
func (p *Poller) maybePrune(ctx context.Context, now time.Time) (int64, error) {
	if !p.lastPrune.IsZero() && now.Sub(p.lastPrune) < p.config.PruneInterval {
		return 0, nil
	}
	p.lastPrune = now

	return p.sink.PruneEvents(ctx, now.Add(-p.config.DetailRetention))
}

// bucketSet collects the minute buckets a cycle touched, deduplicated: a
// busy minute produces hundreds of events but must be recomputed once.
type bucketSet struct {
	seen map[clean.Bucket]struct{}
}

func newBucketSet() *bucketSet {
	return &bucketSet{seen: make(map[clean.Bucket]struct{}, 64)}
}

func (b *bucketSet) add(bucket clean.Bucket) {
	b.seen[bucket] = struct{}{}
}

func (b *bucketSet) len() int {
	return len(b.seen)
}

func (b *bucketSet) slice() []clean.Bucket {
	buckets := make([]clean.Bucket, 0, len(b.seen))
	for bucket := range b.seen {
		buckets = append(buckets, bucket)
	}
	return buckets
}
