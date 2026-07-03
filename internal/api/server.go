package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/observability"
	"github.com/imevul/evuproxy/internal/state"
)

type Server struct {
	Listen                string
	MetricsListen         string // optional loopback-only Prometheus scrape (GET /metrics), no auth
	MetricsListenInsecure bool   // allow non-loopback MetricsListen (explicit opt-in)
	Token                 string
	Config                string
	MetricsDB             string
	Logger                *slog.Logger
	Version               string
	// GeoIP is an optional MaxMind GeoLite2 / GeoIP2 Country MMDB reader. When set, GET /api/v1/logs
	// includes a line_geo array (same order as lines) with src_cc and dst_cc (lowercase ISO 3166-1 alpha-2).
	// The caller should Close the reader when the process exits.
	GeoIP *geoip2.Reader
	// CORSOrigins is a comma-separated list of allowed browser Origin values, or "*" for any.
	// Used when the web UI is served from a different host than the API.
	CORSOrigins string

	// applyMu serializes mutating operations that touch config on disk, nftables, or WireGuard
	// (reload, update-geo, backup, restore, PUT /config, POST /config/discard, POST /config/restore-previous-applied).
	// A second concurrent request fails fast with HTTP 503 and does not queue.
	applyMu sync.Mutex

	EventLog  *eventlog.Logger
	routeTest *slidingLimiter
	logsRL    *slidingLimiter
}

func tokenMatch(got, want string) bool {
	if want == "" {
		return false
	}
	g := sha256.Sum256([]byte(got))
	w := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(g[:], w[:]) == 1
}

func bearerTokenFromRequest(r *http.Request) string {
	authz := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authz) >= 7 && strings.EqualFold(authz[:7], "Bearer ") {
		return strings.TrimSpace(authz[7:])
	}
	return strings.TrimSpace(r.Header.Get("X-API-Token"))
}

// tryMutatingLock acquires applyMu or responds with 503 and returns false.
func (s *Server) tryMutatingLock(w http.ResponseWriter) bool {
	if !s.applyMu.TryLock() {
		s.jsonErr(w, http.StatusServiceUnavailable, "another configuration or apply operation is in progress")
		return false
	}
	return true
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" {
			s.jsonErr(w, http.StatusServiceUnavailable, "API token not configured")
			return
		}
		tok := bearerTokenFromRequest(r)
		if !tokenMatch(tok, s.Token) {
			s.jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) Routes() http.Handler {
	if s.routeTest == nil {
		s.routeTest = newSlidingLimiter()
	}
	if s.logsRL == nil {
		s.logsRL = newSlidingLimiter()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("POST /api/v1/reload", s.auth(s.handleReload))
	mux.HandleFunc("POST /api/v1/update-geo", s.auth(s.handleUpdateGeo))
	mux.HandleFunc("GET /api/v1/status", s.auth(s.handleStatus))
	mux.HandleFunc("GET /api/v1/metrics", s.auth(s.handleMetrics))
	mux.HandleFunc("GET /api/v1/overview", s.auth(s.handleOverview))
	mux.HandleFunc("GET /api/v1/events", s.auth(s.handleEventsGet))
	mux.HandleFunc("GET /api/v1/geo/summary", s.auth(s.handleGeoSummary))
	mux.HandleFunc("GET /api/v1/config.yaml", s.auth(s.handleConfigYAMLGet))
	mux.HandleFunc("GET /api/v1/config", s.auth(s.handleConfigGet))
	mux.HandleFunc("POST /api/v1/routes/test", s.auth(s.handleRouteTest))
	mux.HandleFunc("PUT /api/v1/config", s.auth(s.handleConfigPut))
	mux.HandleFunc("POST /api/v1/config/discard", s.auth(s.handleConfigDiscard))
	mux.HandleFunc("POST /api/v1/config/restore-previous-applied", s.auth(s.handleConfigRestorePreviousApplied))
	mux.HandleFunc("GET /api/v1/pending", s.auth(s.handlePending))
	mux.HandleFunc("POST /api/v1/validate", s.auth(s.handleValidate))
	mux.HandleFunc("GET /api/v1/client-ip", s.auth(s.handleClientIP))
	mux.HandleFunc("POST /api/v1/peers/{index}/qr.png", s.auth(s.handlePeerQR))
	mux.HandleFunc("POST /api/v1/peers/generate-keypair", s.auth(s.handlePeerGenerateKeypair))
	mux.HandleFunc("POST /api/v1/peers/onboard-bundle", s.auth(s.handlePeerOnboardBundle))
	mux.HandleFunc("GET /api/v1/preferences", s.auth(s.handlePreferencesGet))
	mux.HandleFunc("PUT /api/v1/preferences", s.auth(s.handlePreferencesPut))
	mux.HandleFunc("GET /api/v1/config/notes", s.auth(s.handleConfigNotesGet))
	mux.HandleFunc("PUT /api/v1/config/notes", s.auth(s.handleConfigNotesPut))
	mux.HandleFunc("GET /api/v1/metrics/peers", s.auth(s.handleMetricsPeers))
	mux.HandleFunc("GET /api/v1/stats", s.auth(s.handleStats))
	mux.HandleFunc("GET /api/v1/about", s.auth(s.handleAbout))
	mux.HandleFunc("GET /api/v1/logs", s.auth(s.handleLogs))
	mux.HandleFunc("POST /api/v1/backup", s.auth(s.handleBackup))
	mux.HandleFunc("POST /api/v1/restore", s.auth(s.handleRestore))
	return mux
}

func eventDetail(s string) string {
	return apply.TruncateForLog(s, 512)
}

func (s *Server) emit(rec eventlog.Record) {
	if s.EventLog == nil {
		return
	}
	if err := s.EventLog.Append(rec); err != nil && s.Logger != nil {
		s.Logger.Warn("eventlog append", "err", err)
	}
}

func (s *Server) jsonAPIError(w http.ResponseWriter, status int, msg, code string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	out := map[string]string{"error": msg}
	if code != "" {
		out["error_code"] = code
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (s *Server) jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (s *Server) jsonErr(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func (s *Server) logErr(msg string, err error, attrs ...any) {
	if s.Logger == nil {
		return
	}
	args := append([]any{"err", err}, attrs...)
	s.Logger.Error(msg, args...)
}

func (s *Server) Run() error {
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
	if err := state.EnsureApplyStateFromDisk(s.Config); err != nil {
		s.Logger.Warn("apply state bootstrap", "err", err)
	}
	if el, err := eventlog.New(filepath.Dir(s.Config), eventlog.MaxBytesFromEnv()); err != nil {
		s.Logger.Warn("event log disabled", "err", err)
	} else {
		s.EventLog = el
	}
	handler := http.Handler(s.Routes())
	if cors := parseCORSOrigins(s.CORSOrigins); cors != nil {
		if cors.allowAll && !isLoopbackListen(s.Listen) {
			s.Logger.Warn("API listen is not loopback and --cors-origins allows any origin; use an explicit origin list when the API is reachable beyond localhost")
		}
		handler = cors.wrap(handler)
	}
	// ReadHeaderTimeout caps slow request headers (slowloris). ReadTimeout bounds the full
	// request body (e.g. PUT /config up to 2 MiB). WriteTimeout must cover the slowest
	// handler including POST /reload and /update-geo under the apply mutex and GET /logs
	// (~12s subprocess). IdleTimeout limits idle keep-alive connections.
	srv := &http.Server{
		Addr:              s.Listen,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      6 * time.Minute,
		IdleTimeout:       120 * time.Second,
	}
	s.Logger.Info("evuproxy API listening", "addr", s.Listen)
	if ml := strings.TrimSpace(s.MetricsListen); ml != "" {
		if err := observability.ValidateMetricsListen(ml); err != nil {
			if !s.MetricsListenInsecure {
				return fmt.Errorf("metrics listen: %w (use --metrics-listen-insecure to bind anyway)", err)
			}
			s.Logger.Warn("metrics listen address (insecure override)", "err", err)
		}
		go func() {
			if err := RunPrometheusServer(ml, s.Config, s.Logger); err != nil && !errors.Is(err, http.ErrServerClosed) {
				s.Logger.Error("prometheus metrics server", "err", err)
			}
		}()
	}
	return srv.ListenAndServe()
}

func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		host = strings.TrimSpace(addr)
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "::1" || host == "localhost"
}
