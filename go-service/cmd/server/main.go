package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/jaredchao/zuowen-go-service/internal/collector"
	"github.com/jaredchao/zuowen-go-service/internal/server"
	"github.com/jaredchao/zuowen-go-service/internal/store"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL 未设置")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	st, err := store.New(ctx, databaseURL)
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	defer st.Close()

	// The forwarder needs task-role credentials, which only exist on ECS.
	// Locally (or before the role is wired up) /users answers 503 instead
	// of the whole service refusing to start.
	var fwd server.UsersForwarder
	namespace := envOr("COLLECTOR_CLOUDMAP_NAMESPACE", "zuoye.api")
	service := envOr("COLLECTOR_CLOUDMAP_SERVICE", "collector-lambda")
	if col, err := collector.New(ctx, namespace, service); err != nil {
		log.Printf("collector 客户端初始化失败（/users 将返回 503）: %v", err)
	} else {
		fwd = col
	}

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           server.New(st, fwd),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("监听 http://localhost:%s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("服务退出: %v", err)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
