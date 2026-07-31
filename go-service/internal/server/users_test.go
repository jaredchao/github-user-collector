package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jaredchao/zuowen-go-service/internal/intro"
	"github.com/jaredchao/zuowen-go-service/internal/store"
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

func TestGetUser_ForwardsToLambda(t *testing.T) {
	fwd := &fakeForwarder{status: 200, body: `{"username":"torvalds","followers":313974}`}
	h := New(fakeSource{}, fwd)

	req := httptest.NewRequest(http.MethodGet, "/users/torvalds", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 200 || rec.Body.String() != `{"username":"torvalds","followers":313974}` {
		t.Errorf("status=%d body=%s, 期望原样透传", rec.Code, rec.Body.String())
	}
	if fwd.gotMethod != "GET" || fwd.gotPath != "/users/torvalds" {
		t.Errorf("转发参数 = %s %s, 期望 GET /users/torvalds", fwd.gotMethod, fwd.gotPath)
	}
}

func TestGetUser_PendingPassesThrough(t *testing.T) {
	// 采集尚未完成时 Lambda 回 404，前端据此继续轮询。
	fwd := &fakeForwarder{status: 404, body: `{"status":"pending"}`}
	h := New(fakeSource{}, fwd)

	req := httptest.NewRequest(http.MethodGet, "/users/torvalds", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != 404 {
		t.Errorf("status = %d, 期望 404 透传", rec.Code)
	}
}

func TestGetUser_InvalidUsernameRejectedLocally(t *testing.T) {
	fwd := &fakeForwarder{status: 200, body: "{}"}
	h := New(fakeSource{}, fwd)

	req := httptest.NewRequest(http.MethodGet, "/users/-bad-", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, 期望 400", rec.Code)
	}
	if fwd.gotMethod != "" {
		t.Error("非法用户名不该打到 Lambda")
	}
}

func postJSON(t *testing.T, h http.Handler, path string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestGenerateIntroduction_RendersAndPersists(t *testing.T) {
	name := "Linus Torvalds"
	saved := &savedIntro{}
	src := fakeSource{
		user:  intro.User{Username: "torvalds", Name: &name, PublicRepos: 12, Followers: 300},
		saved: saved,
	}
	h := New(src, nil)

	rec := postJSON(t, h, "/users/torvalds/introduction")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, 期望 200，body=%s", rec.Code, rec.Body.String())
	}
	if saved.username != "torvalds" || !strings.Contains(saved.text, "Linus Torvalds") {
		t.Errorf("落库内容不对: %+v", saved)
	}
	if !strings.Contains(rec.Body.String(), "Linus Torvalds") {
		t.Errorf("响应未包含介绍: %s", rec.Body.String())
	}
}

func TestGenerateIntroduction_UnknownUserIs404(t *testing.T) {
	h := New(fakeSource{getErr: store.ErrNotFound}, nil)

	if rec := postJSON(t, h, "/users/nobody/introduction"); rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, 期望 404", rec.Code)
	}
}

// The worker retries on failure, so a write error has to surface as 5xx
// rather than a cheerful 200 that silently drops the introduction.
func TestGenerateIntroduction_SaveFailureIs500(t *testing.T) {
	name := "Linus"
	h := New(fakeSource{user: intro.User{Username: "torvalds", Name: &name}, saveErr: context.DeadlineExceeded}, nil)

	if rec := postJSON(t, h, "/users/torvalds/introduction"); rec.Code != http.StatusInternalServerError {
		t.Errorf("status = %d, 期望 500", rec.Code)
	}
}

func TestGenerateIntroduction_InvalidUsernameIs400(t *testing.T) {
	h := New(fakeSource{}, nil)

	if rec := postJSON(t, h, "/users/-bad-/introduction"); rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, 期望 400", rec.Code)
	}
}
