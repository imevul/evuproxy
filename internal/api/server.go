package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
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
}

func (s *Server) auth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Token == "" {
			http.Error(w, "API token not configured", http.StatusServiceUnavailable)
			return
		}
		tok := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		if tok == "" {
			tok = r.Header.Get("X-API-Token")
		}
		if tok != s.Token {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
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
	if err := apply.Reload(s.Config); err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{"result": "reloaded"})
}

func (s *Server) handleUpdateGeo(w http.ResponseWriter, r *http.Request) {
	if err := apply.UpdateGeo(s.Config); err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{"result": "geo_updated"})
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	out, err := apply.Status(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{"report": out})
}

func (s *Server) handleOverview(w http.ResponseWriter, r *http.Request) {
	o, err := apply.OverviewFromConfig(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, o)
}

func (s *Server) handleConfigGet(w http.ResponseWriter, r *http.Request) {
	c, err := config.Load(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, c)
}

func (s *Server) handleConfigPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	defer r.Body.Close()
	var c config.Config
	if err := json.NewDecoder(r.Body).Decode(&c); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	if err := apply.SaveConfigYAML(s.Config, &c); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{"result": "saved", "hint": "Review and apply from GET /api/v1/pending or POST /api/v1/reload"})
}

func (s *Server) handlePending(w http.ResponseWriter, r *http.Request) {
	info, err := apply.PendingSummary(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, info)
}

func (s *Server) handlePreferencesGet(w http.ResponseWriter, r *http.Request) {
	p, err := apply.LoadUIPreferences(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, p)
}

func (s *Server) handlePreferencesPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	defer r.Body.Close()
	var p apply.UIPreferences
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	p.PeerTunnelSubnetCIDR = strings.TrimSpace(p.PeerTunnelSubnetCIDR)
	p.WireGuardServerEndpoint = strings.TrimSpace(p.WireGuardServerEndpoint)
	if p.PeerTunnelSubnetCIDR != "" {
		if _, _, err := net.ParseCIDR(p.PeerTunnelSubnetCIDR); err != nil {
			s.jsonErr(w, http.StatusBadRequest, "invalid peer_tunnel_subnet_cidr: "+err.Error())
			return
		}
	}
	if err := apply.SaveUIPreferences(s.Config, &p); err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	out, err := apply.LoadUIPreferences(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, out)
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	st, err := apply.StatsFromHost(s.Config)
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
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
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, map[string]any{
		"lines":  lines,
		"source": source,
	})
}

func (s *Server) handleMetrics(w http.ResponseWriter, r *http.Request) {
	fwd, err := exec.Command("nft", "list", "chain", "inet", "evuproxy", "forward").CombinedOutput()
	if err != nil {
		s.jsonErr(w, http.StatusInternalServerError, string(fwd))
		return
	}
	inp, _ := exec.Command("nft", "list", "chain", "inet", "evuproxy", "input").CombinedOutput()
	s.jsonOK(w, map[string]string{
		"forward_chain": string(fwd),
		"input_chain":   string(inp),
	})
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		path = "/var/backups/evuproxy-config.tgz"
	}
	if err := apply.Backup(s.Config, path); err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{"archive": path})
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		s.jsonErr(w, http.StatusBadRequest, "path query required")
		return
	}
	if err := apply.Restore(s.Config, path); err != nil {
		s.jsonErr(w, http.StatusInternalServerError, err.Error())
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

func (s *Server) Run() error {
	if s.Logger == nil {
		s.Logger = slog.Default()
	}
	if err := apply.EnsureApplyStateFromDisk(s.Config); err != nil {
		s.Logger.Warn("apply state bootstrap", "err", err)
	}
	srv := &http.Server{
		Addr:              s.Listen,
		Handler:           s.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.Logger.Info("evuproxy API listening", "addr", s.Listen)
	return srv.ListenAndServe()
}
