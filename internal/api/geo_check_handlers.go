package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
)

type geoCheckRequest struct {
	IP     string          `json:"ip"`
	Config json.RawMessage `json:"config,omitempty"`
}

func (s *Server) handleGeoCheckIP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	rateKey := bearerTokenFromRequest(r)
	if rateKey == "" {
		rateKey = "anon"
	}
	if !s.geoCheck.allow(rateKey, 30, 0, time.Minute) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = w.Write([]byte(`{"error":"rate limit exceeded","error_code":"rate_limit"}`))
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	defer r.Body.Close()
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "could not read request body")
		return
	}
	var req geoCheckRequest
	if len(bytesTrimSpace(body)) > 0 {
		if err := json.Unmarshal(body, &req); err != nil {
			s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
	}
	ip := strings.TrimSpace(req.IP)
	if ip == "" {
		s.jsonErr(w, http.StatusBadRequest, "ip is required")
		return
	}

	var c *config.Config
	fromDraft := false
	if len(bytesTrimSpace(req.Config)) > 0 && string(bytesTrimSpace(req.Config)) != "null" {
		var draft config.Config
		if err := json.Unmarshal(req.Config, &draft); err != nil {
			s.jsonErr(w, http.StatusBadRequest, "invalid config draft")
			return
		}
		c = &draft
		fromDraft = true
	} else {
		loaded, err := config.Load(s.Config)
		if err != nil {
			s.logErr("geo check-ip load", err)
			s.jsonErr(w, http.StatusInternalServerError, "could not read configuration")
			return
		}
		c = loaded
	}

	s.jsonOK(w, apply.CheckSourceIP(c, ip, s.GeoIP, fromDraft))
}
