package clean

import "strings"

// Deliberately coarse user-agent handling. A full UA database would be a
// dependency, a licence and a monthly update chore; the dashboard only needs
// to answer "is mobile slower than desktop" and "which browser is the
// outlier", and substring matching answers both.

var botMarkers = []string{
	"bot", "crawler", "spider", "slurp", "headlesschrome", "phantomjs",
	"lighthouse", "pagespeed", "gtmetrix", "curl/", "wget/", "python-requests",
	"synthetics",
}

// IsBot reports whether the user agent belongs to automated traffic.
func IsBot(ua string) bool {
	lower := strings.ToLower(ua)
	for _, marker := range botMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// ParseUserAgent returns a device class and a browser family.
func ParseUserAgent(ua string) (device string, browser string) {
	lower := strings.ToLower(ua)
	if lower == "" {
		return "unknown", "unknown"
	}

	return deviceOf(lower), browserOf(lower)
}

func deviceOf(lower string) string {
	switch {
	// iPad reports "Macintosh" on iPadOS 13+, so tablet markers are checked
	// before the mobile ones that would also match them.
	case strings.Contains(lower, "ipad"), strings.Contains(lower, "tablet"):
		return "tablet"
	case strings.Contains(lower, "mobile"), strings.Contains(lower, "iphone"), strings.Contains(lower, "android"):
		return "mobile"
	default:
		return "desktop"
	}
}

func browserOf(lower string) string {
	// Order matters: every Chromium browser also says "chrome", and Chrome
	// itself also says "safari".
	switch {
	case strings.Contains(lower, "edg/"):
		return "Edge"
	case strings.Contains(lower, "opr/"), strings.Contains(lower, "opera"):
		return "Opera"
	case strings.Contains(lower, "firefox"):
		return "Firefox"
	case strings.Contains(lower, "chrome"), strings.Contains(lower, "crios"):
		return "Chrome"
	case strings.Contains(lower, "safari"):
		return "Safari"
	default:
		return "other"
	}
}
