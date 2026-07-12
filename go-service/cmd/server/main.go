package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"time"

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

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           server.New(st),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("监听 http://localhost:%s", port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("服务退出: %v", err)
	}
}
