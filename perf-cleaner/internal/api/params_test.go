package api

import (
	"net/url"
	"testing"
	"time"
)

var now = time.Date(2026, 8, 5, 12, 0, 0, 0, time.UTC)

func TestPickBucketSeconds(t *testing.T) {
	tests := []struct {
		name string
		span time.Duration
		want int
	}{
		{"1 小时用分钟桶", time.Hour, 60},
		{"2 小时仍是分钟桶", 2 * time.Hour, 60},
		{"6 小时升到 5 分钟", 6 * time.Hour, 300},
		{"24 小时用 15 分钟", 24 * time.Hour, 900},
		{"7 天用 2 小时", 7 * 24 * time.Hour, 7200},
		{"30 天用 6 小时", 30 * 24 * time.Hour, 6 * 3600},
		{"90 天用天桶", 90 * 24 * time.Hour, 86400},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := PickBucketSeconds(tt.span); got != tt.want {
				t.Errorf("期望 %d，得到 %d", tt.want, got)
			}
		})
	}
}

// Whatever the span, the chart should stay under the point budget.
func TestPickBucketSecondsKeepsPointCountReadable(t *testing.T) {
	for _, span := range []time.Duration{time.Hour, 6 * time.Hour, 24 * time.Hour, 7 * 24 * time.Hour, 90 * 24 * time.Hour} {
		width := PickBucketSeconds(span)
		if points := int(span.Seconds()) / width; points > targetPoints {
			t.Errorf("%s 会产生 %d 个点，超出 %d", span, points, targetPoints)
		}
	}
}

func TestTimeRange(t *testing.T) {
	tests := []struct {
		name     string
		query    string
		wantFrom time.Time
		wantTo   time.Time
		wantErr  bool
	}{
		{"相对区间", "range=6h", now.Add(-6 * time.Hour), now, false},
		{"缺省 24 小时", "", now.Add(-24 * time.Hour), now, false},
		{
			"绝对区间",
			"from=2026-08-05T00:00:00Z&to=2026-08-05T06:00:00Z",
			time.Date(2026, 8, 5, 0, 0, 0, 0, time.UTC),
			time.Date(2026, 8, 5, 6, 0, 0, 0, time.UTC),
			false,
		},
		{"只给 from 则 to 取当前", "from=2026-08-05T06:00:00Z", time.Date(2026, 8, 5, 6, 0, 0, 0, time.UTC), now, false},
		{"range 非法", "range=abc", time.Time{}, time.Time{}, true},
		{"range 为零", "range=0s", time.Time{}, time.Time{}, true},
		{"range 过长", "range=200d", time.Time{}, time.Time{}, true},
		{"时间格式非法", "from=yesterday", time.Time{}, time.Time{}, true},
		{"from 晚于 to", "from=2026-08-05T06:00:00Z&to=2026-08-05T00:00:00Z", time.Time{}, time.Time{}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			values, err := url.ParseQuery(tt.query)
			if err != nil {
				t.Fatal(err)
			}

			from, to, err := TimeRange(values, now)
			if tt.wantErr {
				if err == nil {
					t.Fatal("期望报错")
				}
				return
			}
			if err != nil {
				t.Fatalf("期望成功，得到 %v", err)
			}
			if !from.Equal(tt.wantFrom) || !to.Equal(tt.wantTo) {
				t.Errorf("期望 [%s, %s]，得到 [%s, %s]", tt.wantFrom, tt.wantTo, from, to)
			}
		})
	}
}

// A range selector speaks in days; time.ParseDuration does not.
func TestParseSpanSupportsDays(t *testing.T) {
	tests := []struct {
		value string
		want  time.Duration
	}{
		{"30m", 30 * time.Minute},
		{"6h", 6 * time.Hour},
		{"1d", 24 * time.Hour},
		{"7d", 7 * 24 * time.Hour},
		{"0.5d", 12 * time.Hour},
	}

	for _, tt := range tests {
		got, err := ParseSpan(tt.value)
		if err != nil {
			t.Errorf("ParseSpan(%q) 报错: %v", tt.value, err)
			continue
		}
		if got != tt.want {
			t.Errorf("ParseSpan(%q) 期望 %s，得到 %s", tt.value, tt.want, got)
		}
	}

	for _, bad := range []string{"abc", "d", "7days", "7w"} {
		if _, err := ParseSpan(bad); err == nil {
			t.Errorf("ParseSpan(%q) 应报错", bad)
		}
	}
}

func TestClampLimit(t *testing.T) {
	tests := []struct {
		raw  string
		want int
	}{
		{"", 10},
		{"25", 25},
		{"0", 10},
		{"-5", 10},
		{"abc", 10},
		{"9999", 50},
	}

	for _, tt := range tests {
		if got := clampLimit(tt.raw, 10, 50); got != tt.want {
			t.Errorf("clampLimit(%q) 期望 %d，得到 %d", tt.raw, tt.want, got)
		}
	}
}
