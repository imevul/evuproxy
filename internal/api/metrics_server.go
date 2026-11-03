package api

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/imevul/evuproxy/internal/observability"
)

// metricsHandler serves GET /metrics (Prometheus text). A request must carry token, unless
// token is empty, which leaves the route open.
func metricsHandler(cfgPath, token string) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, r *http.Request) {
		if token != "" && !tokenMatch(bearerTokenFromRequest(r), token) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		body, err := observability.PrometheusText(cfgPath)
		if err != nil {
			http.Error(w, "metrics unavailable", http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		_, _ = w.Write(body)
	})
	return mux
}

// RunPrometheusServer serves metricsHandler on listen, over plain HTTP.
func RunPrometheusServer(listen, cfgPath, token string, logger *slog.Logger) error {
	if logger == nil {
		logger = slog.Default()
	}
	srv := &http.Server{
		Addr:              listen,
		Handler:           metricsHandler(cfgPath, token),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	logger.Info("evuproxy Prometheus metrics listening", "addr", listen)
	return srv.ListenAndServe()
}
