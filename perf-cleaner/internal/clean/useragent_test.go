package clean

import "testing"

func TestParseUserAgent(t *testing.T) {
	tests := []struct {
		name        string
		ua          string
		wantDevice  string
		wantBrowser string
	}{
		{
			"桌面 Chrome",
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
			"desktop", "Chrome",
		},
		{
			"桌面 Safari",
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.1 Safari/605.1.15",
			"desktop", "Safari",
		},
		{
			// Every Chromium browser also says "chrome", so Edge has to be
			// matched before it.
			"Edge 不能被认成 Chrome",
			"Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
			"desktop", "Edge",
		},
		{
			"Opera 不能被认成 Chrome",
			"Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
			"desktop", "Opera",
		},
		{
			"iPhone Safari",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",
			"mobile", "Safari",
		},
		{
			"安卓 Chrome",
			"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36",
			"mobile", "Chrome",
		},
		{
			// iPad also carries "Mobile", so tablet has to win.
			"iPad 算平板不算手机",
			"Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 Version/17.1 Mobile/15E148 Safari/604.1",
			"tablet", "Safari",
		},
		{
			"iOS 上的 Chrome",
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) CriOS/131.0.0.0 Mobile/15E148 Safari/604.1",
			"mobile", "Chrome",
		},
		{"Firefox", "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "desktop", "Firefox"},
		{"空 UA", "", "unknown", "unknown"},
		{"无法识别", "SomeCustomClient/1.0", "desktop", "other"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			device, browser := ParseUserAgent(tt.ua)
			if device != tt.wantDevice || browser != tt.wantBrowser {
				t.Errorf("期望 %s/%s，得到 %s/%s", tt.wantDevice, tt.wantBrowser, device, browser)
			}
		})
	}
}

func TestIsBot(t *testing.T) {
	bots := []string{
		"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
		"Mozilla/5.0 (compatible; bingbot/2.0)",
		"Mozilla/5.0 (compatible; YandexBot/3.0)",
		"Mozilla/5.0 AppleWebKit/537.36 HeadlessChrome/131.0.0.0 Safari/537.36",
		"Mozilla/5.0 Chrome-Lighthouse",
		"curl/8.4.0",
		"python-requests/2.31.0",
		"CloudWatchSynthetics/arn:aws:synthetics",
	}
	for _, ua := range bots {
		if !IsBot(ua) {
			t.Errorf("应识别为爬虫: %s", ua)
		}
	}

	humans := []string{
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.1 Safari/605.1.15",
		"Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36",
		"",
	}
	for _, ua := range humans {
		if IsBot(ua) {
			t.Errorf("不应识别为爬虫: %s", ua)
		}
	}
}
