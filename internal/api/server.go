package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os/exec"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
)

type Server struct {
	Listen string
	Token  string
	Config string
	Logger *slog.Logger
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
	srv := &http.Server{
		Addr:              s.Listen,
		Handler:           s.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	s.Logger.Info("evuproxy API listening", "addr", s.Listen)
	return srv.ListenAndServe()
}
