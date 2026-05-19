package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/imevul/evuproxy/internal/observability"
)

// RunPrometheusServer serves GET /metrics (Prometheus text) on listen. No authentication.
func RunPrometheusServer(listen, cfgPath string, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		body, err := observability.PrometheusText(cfgPath)
		if err != nil {
			http.Error(w, "metrics unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write(body)
	})
	srv := &http.Server{
		Addr:              listen,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	logger.Info("evuproxy Prometheus metrics listening", "addr", listen)
	return srv.ListenAndServe()
}
