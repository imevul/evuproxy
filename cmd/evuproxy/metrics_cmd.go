package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/metrics"
)

func cmdMetrics() *cobra.Command {
	var interval time.Duration
	var dbPath string
	c := &cobra.Command{
		Use:   "metrics",
		Short: "Run background peer ICMP metrics collection into SQLite (respects ui-preferences metrics_collection_enabled)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if dbPath == "" {
				dbPath = apply.MetricsDBDefaultPath(cfgPath)
			}
			return runMetricsLoop(cmd.Context(), cfgPath, dbPath, interval)
		},
	}
	c.Flags().DurationVar(&interval, "interval", 30*time.Second, "interval between collection rounds when enabled")
	c.Flags().StringVar(&dbPath, "db", "", "metrics SQLite path (default: metrics.sqlite beside config)")
	return c
}

func runMetricsLoop(ctx context.Context, cfgPath, dbPath string, interval time.Duration) error {
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	db, err := metrics.OpenWriter(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()

	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{}))

	tick := func() {
		prefs, err := apply.LoadUIPreferences(cfgPath)
		if err != nil {
			log.Error("metrics: preferences", "err", err)
			return
		}
		if !prefs.MetricsCollectionEnabled {
			return
		}
		pctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		results, err := apply.PeersPing(pctx, cfgPath)
		cancel()
		if err != nil {
			log.Error("metrics: ping", "err", err)
			return
		}
		wctx, cancel2 := context.WithTimeout(ctx, 30*time.Second)
		err = metrics.WriteResults(wctx, db, results, time.Now().UTC())
		cancel2()
		if err != nil {
			log.Error("metrics: write", "err", err)
		}
	}

	tick()
	if interval < 5*time.Second {
		interval = 5 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			tick()
		}
	}
}
