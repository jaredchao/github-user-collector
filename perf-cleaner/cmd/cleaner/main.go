package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/cloudwatchlogs"

	"github.com/jaredchao/zuowen-perf-cleaner/internal/api"
	"github.com/jaredchao/zuowen-perf-cleaner/internal/poller"
	"github.com/jaredchao/zuowen-perf-cleaner/internal/store"
)

func main() {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		log.Fatal("DATABASE_URL 未设置")
	}

	logGroup := envOr("PERF_LOG_GROUP", "/perf/raw")
	port := envOr("PORT", "8080")
	detailRetention := time.Duration(envInt("DETAIL_RETENTION_DAYS", 7)) * 24 * time.Hour
	pollInterval := time.Duration(envInt("POLL_INTERVAL_SECONDS", 30)) * time.Second

	// SIGTERM is what ECS sends before it stops a task; the poller finishes
	// its cycle and the HTTP server drains instead of dropping connections.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	startupCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()

	st, err := store.New(startupCtx, databaseURL)
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	defer st.Close()

	awsCfg, err := awsconfig.LoadDefaultConfig(startupCtx)
	if err != nil {
		log.Fatalf("加载 AWS 配置失败: %v", err)
	}

	p := poller.New(cloudwatchlogs.NewFromConfig(awsCfg), st, poller.Config{
		LogGroup:        logGroup,
		Interval:        pollInterval,
		DetailRetention: detailRetention,
	})
	go p.Run(ctx)
	log.Printf("开始轮询日志组 %s，间隔 %s", logGroup, pollInterval)

	handler := api.New(st, api.Config{
		DetailRetention: detailRetention,
		AllowedOrigins:  splitOrigins(os.Getenv("ALLOWED_ORIGINS")),
	})

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("关闭 HTTP 服务失败: %v", err)
		}
	}()

	log.Printf("监听 http://localhost:%s", port)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("服务退出: %v", err)
	}
	log.Print("已退出")
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func splitOrigins(raw string) []string {
	origins := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	return origins
}
