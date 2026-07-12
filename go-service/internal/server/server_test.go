package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/jaredchao/zuowen-go-service/internal/intro"
	"github.com/jaredchao/zuowen-go-service/internal/store"
)

// fakeSource implements UserSource without a database.
type fakeSource struct {
	user    intro.User
	getErr  error
	pingErr error
}

func (f fakeSource) GetUser(_ context.Context, _ string) (intro.User, error) {
	return f.user, f.getErr
}
func (f fakeSource) Ping(_ context.Context) error { return f.pingErr }

func do(t *testing.T, h http.Handler, target string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, target, nil))
	return rec
}

func TestIntro_OK(t *testing.T) {
	name := "Linus Torvalds"
	h := New(fakeSource{user: intro.User{Username: "torvalds", Name: &name, Followers: 100}}, nil)

	rec := do(t, h, "/intro?username=torvalds")
	if rec.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200", rec.Code)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	if body["username"] != "torvalds" {
		t.Errorf("username = %q", body["username"])
	}
	if body["intro"] == "" {
		t.Error("intro 为空")
	}
}

func TestIntro_MissingUsername(t *testing.T) {
	h := New(fakeSource{}, nil)
	if rec := do(t, h, "/intro"); rec.Code != http.StatusBadRequest {
		t.Errorf("缺 username 状态码 = %d, 期望 400", rec.Code)
	}
}

func TestIntro_InvalidUsername(t *testing.T) {
	h := New(fakeSource{}, nil)
	if rec := do(t, h, "/intro?username=-bad-"); rec.Code != http.StatusBadRequest {
		t.Errorf("非法 username 状态码 = %d, 期望 400", rec.Code)
	}
}

func TestIntro_NotFound(t *testing.T) {
	h := New(fakeSource{getErr: store.ErrNotFound}, nil)
	if rec := do(t, h, "/intro?username=nobody"); rec.Code != http.StatusNotFound {
		t.Errorf("不存在用户状态码 = %d, 期望 404", rec.Code)
	}
}

func TestIntro_DBError(t *testing.T) {
	h := New(fakeSource{getErr: context.DeadlineExceeded}, nil)
	if rec := do(t, h, "/intro?username=torvalds"); rec.Code != http.StatusInternalServerError {
		t.Errorf("数据库错误状态码 = %d, 期望 500", rec.Code)
	}
}

func TestHealth_OK(t *testing.T) {
	h := New(fakeSource{}, nil)
	if rec := do(t, h, "/health"); rec.Code != http.StatusOK {
		t.Errorf("health 状态码 = %d, 期望 200", rec.Code)
	}
}

func TestHealth_DBDown(t *testing.T) {
	h := New(fakeSource{pingErr: context.DeadlineExceeded}, nil)
	if rec := do(t, h, "/health"); rec.Code != http.StatusServiceUnavailable {
		t.Errorf("数据库不可用时 health 状态码 = %d, 期望 503", rec.Code)
	}
}
