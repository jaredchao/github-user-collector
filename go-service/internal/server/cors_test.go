package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func doWithOrigin(t *testing.T, h http.Handler, method, path, origin string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, nil)
	req.Header.Set("Origin", origin)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestCORS_ProductionOrigin(t *testing.T) {
	h := New(fakeSource{})
	rec := doWithOrigin(t, h, http.MethodGet, "/health", "https://zuoye-frontend.pages.dev")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://zuoye-frontend.pages.dev" {
		t.Errorf("Allow-Origin = %q, 期望生产域名被回显", got)
	}
}

func TestCORS_PreviewSubdomain(t *testing.T) {
	h := New(fakeSource{})
	rec := doWithOrigin(t, h, http.MethodGet, "/health", "https://pr-7.zuoye-frontend.pages.dev")
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "https://pr-7.zuoye-frontend.pages.dev" {
		t.Errorf("Allow-Origin = %q, 期望预览子域被回显", got)
	}
}

func TestCORS_ForeignOriginRejected(t *testing.T) {
	h := New(fakeSource{})
	for _, origin := range []string{
		"https://evil.example.com",
		// 后缀伪装：不是子域，只是长得像。
		"https://evil-zuoye-frontend.pages.dev",
		// 多级子域不在放行范围。
		"https://a.b.zuoye-frontend.pages.dev",
	} {
		rec := doWithOrigin(t, h, http.MethodGet, "/health", origin)
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
			t.Errorf("origin %s: Allow-Origin = %q, 期望不设置", origin, got)
		}
	}
}

func TestCORS_PreflightAnswered(t *testing.T) {
	h := New(fakeSource{})
	rec := doWithOrigin(t, h, http.MethodOptions, "/intro", "https://pr-7.zuoye-frontend.pages.dev")
	if rec.Code != http.StatusNoContent {
		t.Errorf("OPTIONS 状态码 = %d, 期望 204", rec.Code)
	}
	if got := rec.Header().Get("Access-Control-Allow-Methods"); got == "" {
		t.Error("预检响应缺少 Allow-Methods")
	}
}
