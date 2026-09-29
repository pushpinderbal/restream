package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/pushpinderbal/restream/internal/app"
	"github.com/pushpinderbal/restream/internal/model"
	"github.com/pushpinderbal/restream/internal/stalker"
	"github.com/pushpinderbal/restream/internal/stream"
)

func main() {
	if err := run(); err != nil {
		slog.Error("Restream stopped", "error", err)
		os.Exit(1)
	}
}
func run() error {
	cfg, err := app.LoadConfig()
	if err != nil {
		return err
	}
	var provider model.Provider
	if cfg.PortalURL != "" {
		provider, err = stalker.New(stalker.Config{RequestTimeout: cfg.RequestTimeout, RequestInterval: cfg.RequestInterval, EPGHours: cfg.EPGHours, MaxResponseBytes: cfg.MaxResponseBytes, PortalURL: cfg.PortalURL, MAC: cfg.MAC, Timezone: cfg.Timezone, UserAgent: cfg.UserAgent, SerialNumber: cfg.SerialNumber, DeviceID: cfg.DeviceID, DeviceID2: cfg.DeviceID2})
		if err != nil {
			return err
		}
	}
	var manager *stream.Manager
	if provider != nil {
		manager, err = stream.New(stream.Config{MaxStreams: cfg.MaxStreams, SessionTTL: cfg.SessionTTL, DataDir: cfg.DataDir, FFmpegPath: cfg.FFmpegPath, FFprobePath: cfg.FFprobePath, TranscodeMode: cfg.TranscodeMode}, provider.Resolve)
		if err != nil {
			return err
		}
		defer manager.Close()
	}
	var streams app.Streams
	if manager != nil {
		streams = manager
	}
	server, err := app.New(cfg, provider, streams)
	if err != nil {
		return err
	}
	defer server.Close()
	httpServer := &http.Server{Addr: cfg.ListenAddr, Handler: server, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	done := make(chan error, 1)
	go func() {
		slog.Info("Restream listening", "address", cfg.ListenAddr, "configured", provider != nil, "max_streams", cfg.MaxStreams)
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
