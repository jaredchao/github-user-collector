package store

import (
	"context"
	"errors"
	"os"
	"testing"
)

// These tests hit a real PostgreSQL because pgx.ErrNoRows and the SQL itself
// cannot be mocked meaningfully. Set DATABASE_URL (e.g. the SSM tunnel on
// localhost:5433) to run them; otherwise they skip.
func testStore(t *testing.T) *Store {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL 未设置，跳过需要真实数据库的测试")
	}
	s, err := New(context.Background(), url)
	if err != nil {
		t.Fatalf("连接数据库失败: %v", err)
	}
	t.Cleanup(s.Close)
	return s
}

func TestGetUser_Existing(t *testing.T) {
	s := testStore(t)

	// torvalds was inserted by the assignment-1 Node service and is stable.
	u, err := s.GetUser(context.Background(), "torvalds")
	if err != nil {
		t.Fatalf("查询已存在用户失败: %v", err)
	}
	if u.Username != "torvalds" {
		t.Errorf("username = %q, 期望 torvalds", u.Username)
	}
	if u.Followers <= 0 {
		t.Errorf("followers 应为正数, 得到 %d", u.Followers)
	}
}

func TestGetUser_NotFound(t *testing.T) {
	s := testStore(t)

	_, err := s.GetUser(context.Background(), "no-such-user-zzz999")
	if !errors.Is(err, ErrNotFound) {
		t.Errorf("期望 ErrNotFound, 得到 %v", err)
	}
}

func TestPing(t *testing.T) {
	s := testStore(t)

	if err := s.Ping(context.Background()); err != nil {
		t.Errorf("Ping 失败: %v", err)
	}
}
