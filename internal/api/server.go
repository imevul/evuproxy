package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/geoip"
)

type Server struct {
	Listen  string
	Token   string
	Config  string
	Logger  *slog.Logger
	Version string
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
	mux.HandleFunc("GET /api/v1/preferences", s.auth(s.handlePreferencesGet))
	mux.HandleFunc("PUT /api/v1/preferences", s.auth(s.handlePreferencesPut))
	mux.HandleFunc("GET /api/v1/stats", s.auth(s.handleStats))
	mux.HandleFunc("GET /api/v1/about", s.auth(s.handleAbout))
	mux.HandleFunc("GET /api/v1/logs", s.auth(s.handleLogs))
	mux.HandleFunc("POST /api/v1/backup", s.auth(s.handleBackup))
	mux.HandleFunc("POST /api/v1/restore", s.auth(s.handleRestore))
	return mux
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	s.emit(eventlog.Record{Event: "reload_started", Detail: "reload"})
	if err := apply.Reload(s.Config); err != nil {
		s.logErr("reload", err)
		s.emit(eventlog.Record{Event: "reload_failed", Detail: eventDetail(err.Error()), ErrorCode: "reload_error"})
		s.jsonErr(w, http.StatusInternalServerError, "reload failed")
		return
	}
	apply.InvalidateGeoSummaryCache()
	s.emit(eventlog.Record{Event: "reload_ok", Detail: "reload"})
	s.jsonOK(w, map[string]string{"result": "reloaded"})
}

func (s *Server) handleUpdateGeo(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	s.emit(eventlog.Record{Event: "update_geo_started", Detail: "update-geo"})
	if err := apply.UpdateGeo(s.Config); err != nil {
		s.logErr("update-geo", err)
		s.emit(eventlog.Record{Event: "update_geo_failed", Detail: eventDetail(err.Error()), ErrorCode: "update_geo_error"})
		s.jsonErr(w, http.StatusInternalServerError, "geo update failed")
		return
	}
	apply.InvalidateGeoSummaryCache()
	s.emit(eventlog.Record{Event: "update_geo_ok", Detail: "update-geo"})
	s.jsonOK(w, map[string]string{"result": "geo_updated"})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	out, err := apply.Status(s.Config)
	if err != nil {
		s.logErr("status", err)
		s.jsonErr(w, http.StatusInternalServerError, "status unavailable")
		return
	}
	s.jsonOK(w, map[string]string{"report": out})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	o, err := apply.OverviewFromConfig(s.Config)
	if err != nil {
		s.logErr("overview", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load overview")
		return
	}
	s.jsonOK(w, o)
}

func (s *Server) handleConfigGet(w http.ResponseWriter, r *http.Request) {
	c, err := config.Load(s.Config)
	if err != nil {
		s.logErr("config get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read configuration")
		return
	}
	s.jsonOK(w, c)
}

func (s *Server) handleConfigPut(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	defer r.Body.Close()
	var c config.Config
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		s.logErr("config put decode", err)
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.jsonErr(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := apply.SaveConfigYAML(s.Config, &c); err != nil {
		s.logErr("config put save", err)
		var ve *config.ValidationError
		if errors.As(err, &ve) {
			s.emit(eventlog.Record{Event: "config_put_failed", Detail: eventDetail(ve.Msg), ErrorCode: ve.Code})
			s.jsonAPIError(w, http.StatusBadRequest, ve.Msg, ve.Code)
			return
		}
		s.emit(eventlog.Record{Event: "config_put_failed", Detail: "save failed", ErrorCode: "config_save_error"})
		s.jsonErr(w, http.StatusBadRequest, "could not save configuration")
		return
	}
	s.emit(eventlog.Record{Event: "config_put_ok", Detail: "config saved"})
	s.jsonOK(w, map[string]string{"result": "saved", "hint": "Review and apply from GET /api/v1/pending or POST /api/v1/reload"})
}

func (s *Server) handleConfigDiscard(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	if err := apply.DiscardPendingConfigYAML(s.Config); err != nil {
		s.logErr("config discard", err)
		s.emit(eventlog.Record{Event: "config_discard_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusBadRequest, "could not discard pending changes")
		return
	}
	s.emit(eventlog.Record{Event: "config_discard_ok", Detail: "discarded pending"})
	s.jsonOK(w, map[string]string{"result": "discarded", "hint": "Review GET /api/v1/pending or POST /api/v1/reload"})
}

func (s *Server) handleConfigRestorePreviousApplied(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	if err := apply.RestorePreviousAppliedConfigYAML(s.Config); err != nil {
		s.logErr("config restore previous", err)
		s.emit(eventlog.Record{Event: "config_restore_previous_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusBadRequest, "could not restore previous applied configuration")
		return
	}
	s.emit(eventlog.Record{Event: "config_restore_previous_ok", Detail: "restored previous applied"})
	s.jsonOK(w, map[string]string{"result": "restored", "hint": "Review GET /api/v1/pending or POST /api/v1/reload"})
}

func (s *Server) handlePending(w http.ResponseWriter, r *http.Request) {
	info, err := apply.PendingSummary(s.Config)
	if err != nil {
		s.logErr("pending", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not compute pending state")
		return
	}
	s.jsonOK(w, info)
}

func (s *Server) handlePreferencesGet(w http.ResponseWriter, r *http.Request) {
	p, err := apply.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("preferences get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	s.jsonOK(w, p)
}

func (s *Server) handlePreferencesPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	defer r.Body.Close()
	var p apply.UIPreferences
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		s.logErr("preferences decode", err)
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	p.PeerTunnelSubnetCIDR = strings.TrimSpace(p.PeerTunnelSubnetCIDR)
	p.WireGuardServerEndpoint = strings.TrimSpace(p.WireGuardServerEndpoint)
	if p.PeerTunnelSubnetCIDR != "" {
		if _, _, err := net.ParseCIDR(p.PeerTunnelSubnetCIDR); err != nil {
			s.logErr("preferences cidr", err)
			s.jsonErr(w, http.StatusBadRequest, "invalid peer_tunnel_subnet_cidr")
			return
		}
	}
	if err := apply.SaveUIPreferences(s.Config, &p); err != nil {
		s.logErr("preferences save", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not save preferences")
		return
	}
	out, err := apply.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("preferences reload", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	s.jsonOK(w, out)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	st, err := apply.StatsFromHost(s.Config)
	if err != nil {
		s.logErr("stats", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not collect stats")
		return
	}
	s.jsonOK(w, st)
}

func (s *Server) handleAbout(w http.ResponseWriter, r *http.Request) {
	v := strings.TrimSpace(s.Version)
	if v == "" {
		v = "dev"
	}
	s.jsonOK(w, map[string]string{
		"version":  v,
		"repo_url": "https://github.com/imevul/evuproxy",
	})
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	rateKey := bearerTokenFromRequest(r)
	if rateKey == "" {
		rateKey = "."
	}
	if !s.logsRL.allow(rateKey, 20, 0, time.Minute) {
		s.jsonAPIError(w, http.StatusTooManyRequests, "rate limit exceeded for firewall logs", "rate_limit")
		return
	}
	limit := 200
	if q := strings.TrimSpace(r.URL.Query().Get("limit")); q != "" {
		if n, err := strconv.Atoi(q); err == nil && n > 0 {
			limit = n
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 12*time.Second)
	defer cancel()
	lines, source, err := apply.FirewallDropLogs(ctx, limit)
	if err != nil {
		s.logErr("logs", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read firewall logs")
		return
	}
	out := map[string]any{
		"lines":  lines,
		"source": source,
	}
	if s.GeoIP != nil {
		type lineGeo struct {
			SrcCC string `json:"src_cc,omitempty"`
			DstCC string `json:"dst_cc,omitempty"`
		}
		geo := make([]lineGeo, len(lines))
		for i, line := range lines {
			src, dst := apply.FirewallLogSrcDST(line)
			if cc := geoip.CountryISOCodeLower(s.GeoIP, src); cc != "" {
				geo[i].SrcCC = cc
			}
			if cc := geoip.CountryISOCodeLower(s.GeoIP, dst); cc != "" {
				geo[i].DstCC = cc
			}
		}
		out["line_geo"] = geo
	}
	s.jsonOK(w, out)
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	fwd, inp, err := apply.NFTablesChainsForMetrics()
	if err != nil {
		s.logErr("nft metrics chains", err, "forward_snip", apply.TruncateForLog(string(fwd), 2048), "input_snip", apply.TruncateForLog(string(inp), 2048))
		s.jsonErr(w, http.StatusInternalServerError, "could not list nftables")
		return
	}
	s.jsonOK(w, map[string]string{
		"forward_chain": string(fwd),
		"input_chain":   string(inp),
	})
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/var/backups/evuproxy-config.tgz"
	}
	path, err := apply.ResolveBackupPath(path)
	if err != nil {
		s.logErr("backup path", err)
		s.jsonErr(w, http.StatusBadRequest, "invalid or disallowed backup path")
		return
	}
	if err := apply.Backup(s.Config, path); err != nil {
		s.logErr("backup", err)
		s.emit(eventlog.Record{Event: "backup_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusInternalServerError, "backup failed")
		return
	}
	s.emit(eventlog.Record{Event: "backup_ok", Detail: eventDetail(path)})
	s.jsonOK(w, map[string]string{"archive": path})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	path := r.URL.Query().Get("path")
	if path == "" {
		s.jsonErr(w, http.StatusBadRequest, "path query required")
		return
	}
	path, err := apply.ResolveBackupPath(path)
	if err != nil {
		s.logErr("restore path", err)
		s.jsonErr(w, http.StatusBadRequest, "invalid or disallowed restore path")
		return
	}
	if err := apply.Restore(s.Config, path); err != nil {
		s.logErr("restore", err)
		s.emit(eventlog.Record{Event: "restore_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusInternalServerError, "restore failed")
		return
	}
	s.emit(eventlog.Record{Event: "restore_ok", Detail: eventDetail(path)})
	s.jsonOK(w, map[string]string{"result": "restored", "hint": "run evuproxy reload"})
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

func (s *Server) handleConfigYAMLGet(w http.ResponseWriter, r *http.Request) {
	b, err := os.ReadFile(s.Config)
	if err != nil {
		s.logErr("config yaml get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read configuration file")
		return
	}
	w.Header().Set("Content-Type", "application/x-yaml; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="config.yaml"`)
	_, _ = w.Write(b)
}

func (s *Server) handleEventsGet(w http.ResponseWriter, r *http.Request) {
	limit := 50
	if q := strings.TrimSpace(r.URL.Query().Get("limit")); q != "" {
		n, err := strconv.Atoi(q)
		if err != nil || n < 1 || n > 200 {
			s.jsonAPIError(w, http.StatusBadRequest, "invalid limit (use 1-200)", "invalid_limit")
			return
		}
		limit = n
	}
	if s.EventLog == nil {
		s.jsonOK(w, map[string]any{"events": []any{}})
		return
	}
	recs, err := s.EventLog.ReadTail(limit)
	if err != nil {
		s.logErr("events get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read events")
		return
	}
	type row struct {
		Ts         string `json:"ts"`
		Event      string `json:"event"`
		Detail     string `json:"detail,omitempty"`
		HTTPStatus int    `json:"http_status,omitempty"`
		ErrorCode  string `json:"error_code,omitempty"`
	}
	out := make([]row, 0, len(recs))
	for _, e := range recs {
		out = append(out, row{
			Ts:         e.Ts.UTC().Format(time.RFC3339),
			Event:      e.Event,
			Detail:     e.Detail,
			HTTPStatus: e.HTTPStatus,
			ErrorCode:  e.ErrorCode,
		})
	}
	s.jsonOK(w, map[string]any{"events": out})
}

func (s *Server) handleGeoSummary(w http.ResponseWriter, r *http.Request) {
	g, err := apply.GeoSummary(s.Config)
	if err != nil {
		s.logErr("geo summary", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not build geo summary")
		return
	}
	s.jsonOK(w, g)
}

func (s *Server) handleRouteTest(w http.ResponseWriter, r *http.Request) {
	rateKey := bearerTokenFromRequest(r)
	if rateKey == "" {
		rateKey = "."
	}
	if !s.routeTest.allow(rateKey, 10, 0, time.Minute) {
		s.jsonAPIError(w, http.StatusTooManyRequests, "rate limit exceeded for route tests", "rate_limit")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	defer r.Body.Close()
	var body struct {
		RouteIndex int `json:"route_index"`
		Port       int `json:"port"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<14)).Decode(&body); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if !s.applyMu.TryLock() {
		s.jsonErr(w, http.StatusServiceUnavailable, "another configuration or apply operation is in progress")
		return
	}
	c, err := config.Load(s.Config)
	s.applyMu.Unlock()
	if err != nil {
		s.logErr("route test load config", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load configuration")
		return
	}
	res, err := apply.ProbeForwardingRoute(r.Context(), c, body.RouteIndex, body.Port)
	if err != nil {
		s.logErr("route test probe", err)
		s.jsonErr(w, http.StatusBadRequest, routeTestClientMsg(err))
		return
	}
	s.jsonOK(w, map[string]any{"results": res})
}

func routeTestClientMsg(err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return "probe timed out or canceled"
	}
	msg := err.Error()
	switch {
	case strings.Contains(msg, "invalid route_index"):
		return "invalid route index"
	case strings.Contains(msg, "route is disabled"):
		return "route is disabled"
	case strings.Contains(msg, "route has no ports"):
		return "route has no ports"
	case strings.Contains(msg, "port not in route"):
		return "port not in route"
	case strings.Contains(msg, "invalid target_ip"):
		return "invalid target IP"
	case strings.Contains(msg, "invalid proto"):
		return "invalid route protocol"
	default:
		return "route test failed"
	}
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
	if err := apply.EnsureApplyStateFromDisk(s.Config); err != nil {
		s.Logger.Warn("apply state bootstrap", "err", err)
	}
	if el, err := eventlog.New(filepath.Dir(s.Config), eventlog.MaxBytesFromEnv()); err != nil {
		s.Logger.Warn("event log disabled", "err", err)
	} else {
		s.EventLog = el
	}
	handler := http.Handler(s.Routes())
	if cors := parseCORSOrigins(s.CORSOrigins); cors != nil {
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
	return srv.ListenAndServe()
}
