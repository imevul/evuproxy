package api

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/geoip"
	"github.com/imevul/evuproxy/internal/metrics"
	"github.com/imevul/evuproxy/internal/state"
)

// metricsOpenQuietReason maps open failures to a coarse log label (no raw driver strings).
// path is the metrics DB path used for this attempt; SQLite often returns SQLITE_CANTOPEN
// instead of os.ErrNotExist when the file or parent directory is missing, so we also os.Stat(path).
func metricsOpenQuietReason(path string, err error) string {
	if err == nil {
		return ""
	}
	if errors.Is(err, metrics.ErrSchemaNotReady) {
		return "schema_not_initialized"
	}
	if errors.Is(err, os.ErrNotExist) {
		return "not_found"
	}
	if strings.TrimSpace(path) != "" {
		if _, statErr := os.Stat(path); statErr != nil && os.IsNotExist(statErr) {
			return "not_found"
		}
	}
	return "open_failed"
}

func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	out, err := apply.Status(r.Context(), s.Config)
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

func (s *Server) metricsDBPath() string {
	if strings.TrimSpace(s.MetricsDB) != "" {
		return filepath.Clean(s.MetricsDB)
	}
	return state.MetricsDBDefaultPath(s.Config)
}

func (s *Server) handleMetricsPeers(w http.ResponseWriter, r *http.Request) {
	prefs, err := state.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("metrics peers preferences", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	path := s.metricsDBPath()
	var db *sql.DB
	if d, err := metrics.OpenReader(path); err == nil {
		db = d
		defer db.Close()
	} else {
		s.Logger.Debug("metrics db unavailable", "reason", metricsOpenQuietReason(path, err))
	}
	out, err := metrics.BuildPeersResponse(r.Context(), db, !prefs.MetricsCollectionEnabled)
	if err != nil {
		s.logErr("metrics peers", err)
		s.jsonErr(w, http.StatusInternalServerError, "metrics unavailable")
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
