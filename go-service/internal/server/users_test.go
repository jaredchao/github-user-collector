package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeForwarder struct {
	gotMethod string
	gotPath   string
	gotBody   string
	status    int
	body      string
	err       error
}

func (f *fakeForwarder) Forward(ctx context.Context, method, path string, body []byte) (int, []byte, error) {
	f.gotMethod, f.gotPath, f.gotBody = method, path, string(body)
	if f.err != nil {
		return 0, nil, f.err
	}
	return f.status, []byte(f.body), nil
}

func doPost(t *testing.T, h http.Handler, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestUsers_PassesThrough(t *testing.T) {
	fwd := &fakeForwarder{status: 201, body: `{"username":"torvalds"}`}
	h := New(fakeSource{}, fwd)

	rec := doPost(t, h, "/users", `{"username":"torvalds"}`)

	if rec.Code != 201 || rec.Body.String() != `{"username":"torvalds"}` {
		t.Errorf("status=%d body=%s, 期望 Lambda 响应原样透传", rec.Code, rec.Body.String())
	}
	if fwd.gotMethod != "POST" || fwd.gotPath != "/users" || fwd.gotBody != `{"username":"torvalds"}` {
		t.Errorf("转发参数不对: %s %s %s", fwd.gotMethod, fwd.gotPath, fwd.gotBody)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type = %q", ct)
	}
}

func TestUsers_LambdaErrorStatusPassesThrough(t *testing.T) {
	fwd := &fakeForwarder{status: 404, body: `{"error":"GitHub user not found"}`}
	h := New(fakeSource{}, fwd)
	if rec := doPost(t, h, "/users", `{"username":"nobody"}`); rec.Code != 404 {
		t.Errorf("status = %d, 期望 404 透传", rec.Code)
	}
}

func TestUsers_ForwarderFailureIs502(t *testing.T) {
	fwd := &fakeForwarder{err: context.DeadlineExceeded}
	h := New(fakeSource{}, fwd)
	if rec := doPost(t, h, "/users", `{"username":"x"}`); rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, 期望 502", rec.Code)
	}
}

func TestUsers_NoForwarderIs503(t *testing.T) {
	h := New(fakeSource{}, nil)
	if rec := doPost(t, h, "/users", `{"username":"x"}`); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, 期望 503", rec.Code)
	}
}

func TestCORS_PreflightAllowsPost(t *testing.T) {
	h := New(fakeSource{}, nil)
	rec := doWithOrigin(t, h, http.MethodOptions, "/users", "https://zuoye-frontend.pages.dev")
	allow := rec.Header().Get("Access-Control-Allow-Methods")
	if !strings.Contains(allow, "POST") {
		t.Errorf("Allow-Methods = %q, 期望包含 POST", allow)
	}
	if headers := rec.Header().Get("Access-Control-Allow-Headers"); !strings.Contains(headers, "Content-Type") {
		t.Errorf("Allow-Headers = %q, 期望包含 Content-Type", headers)
	}
}
