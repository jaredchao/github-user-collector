package clean

// Same Web Vitals thresholds the SDK uses. They are duplicated here on
// purpose: a line whose rating is missing or unrecognised can be repaired
// instead of dropped, and the two copies are pinned together by the
// SchemaVersion contract.
var thresholds = map[string][2]float64{
	"LCP":      {2500, 4000},
	"FCP":      {1800, 3000},
	"CLS":      {0.1, 0.25},
	"INP":      {200, 500},
	"TTFB":     {800, 1800},
	"RESOURCE": {1000, 3000},
	"LONGTASK": {100, 250},
}

func rate(metric string, value float64) string {
	bounds, ok := thresholds[metric]
	// CUSTOM and ERROR have no universal scale.
	if !ok {
		return "good"
	}
	switch {
	case value <= bounds[0]:
		return "good"
	case value <= bounds[1]:
		return "needs-improvement"
	default:
		return "poor"
	}
}
