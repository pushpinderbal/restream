package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pushpinderbal/restream/internal/app"
)

func main() {
	development := flag.Bool("dev", false, "Use local data and web paths for development with Vite")
	flag.Parse()
	if err := run(*development); err != nil {
		slog.Error("Restream stopped", "error", err)
		os.Exit(1)
	}
}
func run(development bool) error {
	cfg, err := app.LoadConfig()
	if err != nil {
		return err
	}
	if development {
		cfg.DataDir, cfg.WebDir = "./data", "./web/dist"
		if os.Getenv("LISTEN_ADDR") == "" {
			cfg.ListenAddr = "127.0.0.1:8080"
		}
	}
	server, err := app.NewRuntime(cfg)
	if err != nil {
		return err
	}
	defer server.Close()
	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: server, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() {
		slog.Info("Restream listening", "address", cfg.ListenAddr)
		done <- httpServer.ListenAndServe()
	}()
	select {
	case err = <-done:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
	}
	slog.Info("Restream shutting down")
	shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return httpServer.Shutdown(shutdown)
}
