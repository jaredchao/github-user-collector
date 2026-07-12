// Package server wires HTTP routes to the store and intro packages.
package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
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

// UsersForwarder relays a request to the collector Lambda. Defined here so
// tests can fake it without AWS.
type UsersForwarder interface {
	Forward(ctx context.Context, method, path string, body []byte) (int, []byte, error)
}

// New returns an http.Handler with the /intro, /users and /health routes.
func New(src UserSource, fwd UsersForwarder) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		if err := src.Ping(r.Context()); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"status": "db unavailable"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /intro", handleIntro(src))
	mux.HandleFunc("POST /users", handleUsers(fwd))
	return withCORS(mux)
}

// handleUsers forwards the search/collect request to the Lambda and passes
// its verdict through untouched, so the frontend sees the same status codes
// it would get from API Gateway.
func handleUsers(fwd UsersForwarder) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if fwd == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "采集服务未配置"})
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 4096))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "请求体过大或不可读"})
			return
		}
		status, respBody, err := fwd.Forward(r.Context(), http.MethodPost, "/users", body)
		if err != nil {
			log.Printf("转发 /users 失败: %v", err)
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "采集服务暂时不可用"})
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(status)
		w.Write(respBody)
	}
}

// The frontend calls this service directly through the ALB (the homework's
// "external" path), so browsers need CORS. The Pages project domain is fixed
// for this project; previews live one label below it (pr-N.<project>).
const frontendOrigin = "https://zuoye-frontend.pages.dev"

var previewOrigin = regexp.MustCompile(`^https://[a-z0-9-]+\.zuoye-frontend\.pages\.dev$`)

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin == frontendOrigin || previewOrigin.MatchString(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
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
