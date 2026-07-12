// Package server wires HTTP routes to the store and intro packages.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"regexp"

	"github.com/jaredchao/zuowen-go-service/internal/intro"
	"github.com/jaredchao/zuowen-go-service/internal/store"
)

// GitHub usernames: alphanumerics with single inner hyphens, up to 39 chars,
// no leading/trailing hyphen. Go's RE2 engine has no lookahead, so the
// "no double hyphen" rule is a second check rather than an inline assertion.
var (
	usernameChars  = regexp.MustCompile(`^[a-zA-Z0-9-]{1,39}$`)
	usernameHyphen = regexp.MustCompile(`^-|-$|--`)
)

func validUsername(s string) bool {
	return usernameChars.MatchString(s) && !usernameHyphen.MatchString(s)
}

// UserSource is the read-only dependency the server needs. Defining it here
// (not in store) lets tests supply a fake without a database.
type UserSource interface {
	GetUser(ctx context.Context, username string) (intro.User, error)
	Ping(ctx context.Context) error
}

// New returns an http.Handler with the /intro and /health routes.
func New(src UserSource) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if err := src.Ping(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /intro", handleIntro(src))
	return mux
}

func handleIntro(src UserSource) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		username := r.URL.Query().Get("username")
		if !validUsername(username) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username 缺失或格式非法"})
			return
		}

		user, err := src.GetUser(r.Context(), username)
		if errors.Is(err, store.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "找不到这个 GitHub 用户"})
			return
		}
		if err != nil {
			log.Printf("GetUser(%q) 失败: %v", username, err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "服务器内部错误"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"username": user.Username,
			"intro":    intro.Build(user),
		})
	}
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
