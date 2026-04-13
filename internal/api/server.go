package api

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
)

type Server struct {
	Listen  string
	Token   string
	Config  string
	Logger  *slog.Logger
	Version string
	// CORSOrigins is a comma-separated list of allowed browser Origin values, or "*" for any.
	// Used when the web UI is served from a different host than the API.
	CORSOrigins string

	// applyMu serializes mutating operations that touch config on disk, nftables, or WireGuard
	// (reload, update-geo, backup, restore, PUT /config). A second concurrent request fails fast
	// with HTTP 503 and does not queue.
	applyMu sync.Mutex
}

func tokenMatch(got, want string) bool {
	if want == "" {
		return false
	}
	g := sha256.Sum256([]byte(got))
	w := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(g[:], w[:]) == 1
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
		tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if tok == "" {
			tok = r.Header.Get("X-API-Token")
		}
		if !tokenMatch(tok, s.Token) {
			s.jsonErr(w, http.StatusUnauthorized, "unauthorized")
			return
		}
		next(w, r)
	}
}

func (s *Server) Routes() http.Handler {
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
	mux.HandleFunc("GET /api/v1/config", s.auth(s.handleConfigGet))
	mux.HandleFunc("PUT /api/v1/config", s.auth(s.handleConfigPut))
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
	if err := apply.Reload(s.Config); err != nil {
		s.logErr("reload", err)
		s.jsonErr(w, http.StatusInternalServerError, "reload failed")
		return
	}
	s.jsonOK(w, map[string]string{"result": "reloaded"})
}

func (s *Server) handleUpdateGeo(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	if err := apply.UpdateGeo(s.Config); err != nil {
		s.logErr("update-geo", err)
		s.jsonErr(w, http.StatusInternalServerError, "geo update failed")
		return
	}
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
		s.jsonErr(w, http.StatusBadRequest, "could not save configuration")
		return
	}
	s.jsonOK(w, map[string]string{"result": "saved", "hint": "Review and apply from GET /api/v1/pending or POST /api/v1/reload"})
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
	s.jsonOK(w, map[string]any{
		"lines":  lines,
		"source": source,
	})
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
		s.jsonErr(w, http.StatusInternalServerError, "backup failed")
		return
	}
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
		s.jsonErr(w, http.StatusInternalServerError, "restore failed")
		return
	}
	s.jsonOK(w, map[string]string{"result": "restored", "hint": "run evuproxy reload"})
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
