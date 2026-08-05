package poller

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/clean"
)

// Stats is one cycle's tally. Rejections are counted by reason rather than
// summed: "300 dropped" says nothing, while "300 dropped as bot traffic"
// and "300 dropped as unknown metric" call for opposite responses.
type Stats struct {
	Scanned    int
	Cleaned    int
	Inserted   int
	Duplicates int
	Buckets    int
	Pruned     int64
	Rejected   map[string]int
}

func NewStats() Stats {
	return Stats{Rejected: make(map[string]int, 6)}
}

// Known rejection reasons, in the order they read best in a log line.
var rejectionReasons = []struct {
	err   error
	label string
}{
	{clean.ErrMalformed, "格式非法"},
	{clean.ErrSchema, "版本不符"},
	{clean.ErrMissingField, "字段缺失"},
	{clean.ErrUnknownMetric, "未知指标"},
	{clean.ErrOutOfRange, "超出范围"},
	{clean.ErrBot, "爬虫流量"},
}

// Reject records one dropped line under its reason.
func (s *Stats) Reject(err error) {
	for _, reason := range rejectionReasons {
		if errors.Is(err, reason.err) {
			s.Rejected[reason.label]++
			return
		}
	}
	s.Rejected["其他"]++
}

// TotalRejected is the sum across reasons.
func (s Stats) TotalRejected() int {
	total := 0
	for _, count := range s.Rejected {
		total += count
	}
	return total
}

func (s Stats) String() string {
	parts := []string{
		fmt.Sprintf("扫描 %d", s.Scanned),
		fmt.Sprintf("入库 %d", s.Inserted),
	}
	if s.Duplicates > 0 {
		parts = append(parts, fmt.Sprintf("重复 %d", s.Duplicates))
	}
	if s.Buckets > 0 {
		parts = append(parts, fmt.Sprintf("重算 %d 个分钟桶", s.Buckets))
	}
	if s.Pruned > 0 {
		parts = append(parts, fmt.Sprintf("清理 %d 条过期明细", s.Pruned))
	}

	// Map iteration order is random in Go; sorting keeps successive log
	// lines comparable by eye.
	if total := s.TotalRejected(); total > 0 {
		labels := make([]string, 0, len(s.Rejected))
		for label, count := range s.Rejected {
			labels = append(labels, fmt.Sprintf("%s %d", label, count))
		}
		sort.Strings(labels)
		parts = append(parts, fmt.Sprintf("丢弃 %d（%s）", total, strings.Join(labels, ", ")))
	}

	return strings.Join(parts, ", ")
}
