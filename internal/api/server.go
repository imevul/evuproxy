package api

import (
	"context"
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
	"sync/atomic"
	"time"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/autopause"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/observability"
	"github.com/imevul/evuproxy/internal/state"
)

type Server struct {
	Listen                string
	MetricsListen         string // optional loopback-only Prometheus scrape (GET /metrics), no auth
	MetricsListenInsecure bool   // allow non-loopback MetricsListen (explicit opt-in)
	Token                 string
	// ReadToken is an optional second token, limited to the read routes in apiRoutes.
	ReadToken string
	Config    string
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
	// MTLSListen is an optional extra listener that requires a client certificate signed by
	// MTLSClientCAFile as well as the API token. The four MTLS fields are set together or not at all.
	MTLSListen       string
	MTLSCertFile     string
	MTLSKeyFile      string
	MTLSClientCAFile string

	// applyMu serializes mutating operations that touch config on disk, nftables, or WireGuard
	// (reload, update-geo, backup, restore, PUT /config, POST /config/discard, POST /config/restore-previous-applied).
	// A second concurrent request fails fast with HTTP 503 and does not queue.
	applyMu sync.Mutex
	// reloadStep is the stage of the running reload (a string), empty when none is running.
	reloadStep atomic.Value

	EventLog  *eventlog.Logger
	routeTest *slidingLimiter
	logsRL    *slidingLimiter
	diagRL    *slidingLimiter
	geoCheck  *slidingLimiter
	// autoPause is set by Run before the listener starts; nil means no route is paused.
	autoPause *autopause.Loop
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

// tokenScope is what a route needs, or what a token grants. Write is the zero value, so
// a route nobody classified needs the write token.
type tokenScope int

const (
	scopeWrite tokenScope = iota
	scopeRead
)

func (sc tokenScope) String() string {
	if sc == scopeRead {
		return "read"
	}
	return "write"
}

// insufficientScopeCode is the error_code of a 403 from a read token on a write route.
const insufficientScopeCode = "insufficient_scope"

// scopeOf returns what a token grants. ok is false for a token that is neither of ours.
func (s *Server) scopeOf(tok string) (scope tokenScope, ok bool) {
	// Both compared every time, so the answer's timing doesn't say which one nearly matched.
	write := tokenMatch(tok, s.Token)
	read := tokenMatch(tok, s.ReadToken)
	switch {
	case write:
		return scopeWrite, true
	case read:
		return scopeRead, true
	}
	return scopeWrite, false
}

func (s *Server) auth(scope tokenScope, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" && s.ReadToken == "" {
			s.jsonErr(w, http.StatusServiceUnavailable, "API token not configured")
			return
		}
		granted, ok := s.scopeOf(bearerTokenFromRequest(r))
		if !ok {
			s.jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		if scope == scopeWrite && granted != scopeWrite {
			s.jsonAPIError(w, http.StatusForbidden, "this route needs the write token", insufficientScopeCode)
			return
		}
		next(w, r)
	}
}

type apiRoute struct {
	pattern string
	scope   tokenScope
	handler http.HandlerFunc
}

// apiRoutes lists every /api/v1 route. Leave out scope and a route needs the write token.
// Read is for what a monitoring token may see: status, overview, stats, logs, events and
// metrics. Anything that shows the config, even as a GET, stays on write. See docs/http-api.md.
func (s *Server) apiRoutes() []apiRoute {
	return []apiRoute{
		{pattern: "POST /api/v1/reload", handler: s.handleReload},
		{pattern: "GET /api/v1/reload/progress", handler: s.handleReloadProgress},
		{pattern: "GET /api/v1/apply/session", handler: s.handleApplySession},
		{pattern: "POST /api/v1/apply/confirm", handler: s.handleApplyConfirm},
		{pattern: "POST /api/v1/apply/revert", handler: s.handleApplyRevert},
		{pattern: "POST /api/v1/apply/reverted/restore", handler: s.handleApplyRevertedRestore},
		{pattern: "POST /api/v1/apply/reverted/dismiss", handler: s.handleApplyRevertedDismiss},
		{pattern: "POST /api/v1/update-geo", handler: s.handleUpdateGeo},
		{pattern: "GET /api/v1/status", scope: scopeRead, handler: s.handleStatus},
		{pattern: "GET /api/v1/metrics", scope: scopeRead, handler: s.handleMetrics},
		{pattern: "GET /api/v1/overview", scope: scopeRead, handler: s.handleOverview},
		{pattern: "GET /api/v1/events", scope: scopeRead, handler: s.handleEventsGet},
		{pattern: "GET /api/v1/auto-pause", handler: s.handleAutoPause},
		{pattern: "GET /api/v1/geo/summary", handler: s.handleGeoSummary},
		{pattern: "POST /api/v1/geo/check-ip", handler: s.handleGeoCheckIP},
		{pattern: "GET /api/v1/config.yaml", handler: s.handleConfigYAMLGet},
		{pattern: "GET /api/v1/config", handler: s.handleConfigGet},
		{pattern: "POST /api/v1/routes/test", handler: s.handleRouteTest},
		{pattern: "PUT /api/v1/config", handler: s.handleConfigPut},
		{pattern: "POST /api/v1/config/discard", handler: s.handleConfigDiscard},
		{pattern: "POST /api/v1/config/restore-previous-applied", handler: s.handleConfigRestorePreviousApplied},
		{pattern: "GET /api/v1/pending", handler: s.handlePending},
		{pattern: "POST /api/v1/validate", handler: s.handleValidate},
		{pattern: "GET /api/v1/client-ip", handler: s.handleClientIP},
		{pattern: "POST /api/v1/peers/{index}/qr.png", handler: s.handlePeerQR},
		{pattern: "POST /api/v1/peers/generate-keypair", handler: s.handlePeerGenerateKeypair},
		{pattern: "POST /api/v1/peers/onboard-bundle", handler: s.handlePeerOnboardBundle},
		{pattern: "GET /api/v1/preferences", handler: s.handlePreferencesGet},
		{pattern: "PUT /api/v1/preferences", handler: s.handlePreferencesPut},
		{pattern: "GET /api/v1/config/notes", handler: s.handleConfigNotesGet},
		{pattern: "PUT /api/v1/config/notes", handler: s.handleConfigNotesPut},
		{pattern: "GET /api/v1/metrics/peers", scope: scopeRead, handler: s.handleMetricsPeers},
		{pattern: "GET /api/v1/stats", scope: scopeRead, handler: s.handleStats},
		{pattern: "GET /api/v1/about", handler: s.handleAbout},
		{pattern: "GET /api/v1/logs", scope: scopeRead, handler: s.handleLogs},
		{pattern: "GET /api/v1/diagnostics.md", handler: s.handleDiagnosticsMD},
		{pattern: "POST /api/v1/backup", handler: s.handleBackup},
		{pattern: "GET /api/v1/backup/info", handler: s.handleBackupInfo},
		{pattern: "POST /api/v1/restore", handler: s.handleRestore},
	}
}

func (s *Server) Routes() http.Handler {
	if s.routeTest == nil {
		s.routeTest = newSlidingLimiter()
	}
	if s.logsRL == nil {
		s.logsRL = newSlidingLimiter()
	}
	if s.diagRL == nil {
		s.diagRL = newSlidingLimiter()
	}
	if s.geoCheck == nil {
		s.geoCheck = newSlidingLimiter()
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	for _, route := range s.apiRoutes() {
		mux.HandleFunc(route.pattern, s.auth(route.scope, route.handler))
	}
	return s.crossOriginGuard(mux)
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
	// After a reboot inside a confirm window the timer is gone, and nothing else would
	// revert if the boot unit is disabled. With a live timer this leaves the session alone.
	if err := apply.RecoverConfirmSession(context.Background(), s.Config); err != nil {
		s.Logger.Error("recover apply session", "err", err)
	}
	mtls, err := s.mtlsConfig()
	if err != nil {
		return err
	}
	if err := state.EnsureApplyStateFromDisk(s.Config); err != nil {
		s.Logger.Warn("apply state bootstrap", "err", err)
	}
	if s.ReadToken != "" && s.ReadToken == s.Token {
		s.Logger.Warn("the read token is the same as the write token, so it has full access; give it its own value")
	}
	if el, err := eventlog.New(filepath.Dir(s.Config), eventlog.MaxBytesFromEnv()); err != nil {
		s.Logger.Warn("event log disabled", "err", err)
	} else {
		s.EventLog = el
	}
	s.autoPause = &autopause.Loop{
		Load:   func() (*config.Config, error) { return autopause.LoadConfig(s.Config) },
		Prober: autopause.HostProber{},
		Logger: s.Logger,
		Emit:   s.emit,
		SyncRules: func(ctx context.Context, paused func(*config.Config) []int) error {
			return apply.SyncPausedRoutes(ctx, s.Config, paused)
		},
	}
	go s.autoPause.Run(context.Background())
	handler := http.Handler(s.Routes())
	if cors := parseCORSOrigins(s.CORSOrigins); cors != nil {
		if cors.allowAll && s.reachableBeyondLoopback(mtls) {
			s.Logger.Warn("API listen is not loopback and --cors-origins allows any origin; use an explicit origin list when the API is reachable beyond localhost")
		}
		if cors.allowAll {
			s.Logger.Warn("--cors-origins allows any origin, so cross-origin refusal of state-changing requests is off")
		}
		handler = cors.wrap(handler)
	}
	// ReadHeaderTimeout caps slow request headers (slowloris). ReadTimeout bounds the full
	// request body (e.g. PUT /config up to 2 MiB). WriteTimeout must cover the slowest
	// handler including POST /reload and /update-geo under the apply mutex and GET /logs
	// (~12s subprocess). IdleTimeout limits idle keep-alive connections.
	newHTTPServer := func(addr string) *http.Server {
		return &http.Server{
			Addr:              addr,
			Handler:           handler,
			ReadHeaderTimeout: 10 * time.Second,
			ReadTimeout:       60 * time.Second,
			WriteTimeout:      6 * time.Minute,
			IdleTimeout:       120 * time.Second,
		}
	}
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
	// The first listener to fail ends the process: staying up without the mTLS listener would
	// hide the failure from systemd while clients that depend on it get refused.
	errc := make(chan error, 2)
	if !s.plainListenDisabled(mtls) {
		s.Logger.Info("evuproxy API listening", "addr", s.Listen)
		if mtls != nil && !isLoopbackListen(s.Listen) {
			s.Logger.Warn("API listen is not loopback and accepts the token without a client certificate; bind it to loopback or disable it with --listen \"\" when using mTLS")
		}
		srv := newHTTPServer(s.Listen)
		go func() { errc <- srv.ListenAndServe() }()
	}
	if mtls != nil {
		s.Logger.Info("evuproxy API listening with client certificates required", "addr", s.MTLSListen)
		srv := newHTTPServer(strings.TrimSpace(s.MTLSListen))
		srv.TLSConfig = mtls
		go func() { errc <- srv.ListenAndServeTLS("", "") }()
	}
	return <-errc
}

func isLoopbackListen(addr string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(addr))
	if err != nil {
		host = strings.TrimSpace(addr)
	}
	host = strings.Trim(host, "[]")
	return host == "127.0.0.1" || host == "::1" || host == "localhost"
}
