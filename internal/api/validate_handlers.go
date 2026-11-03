package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

func bytesTrimSpace(b []byte) []byte {
	return bytes.TrimSpace(b)
}

func (s *Server) handleValidate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		s.jsonErr(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2<<20)
	defer r.Body.Close()

	clientIP := DetectClientIP(r)
	clientIP.ConnPort = detectConnPort(r)
	var draft *config.Config
	body, err := io.ReadAll(r.Body)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "could not read request body")
		return
	}
	body = bytesTrimSpace(body)
	if len(body) > 0 && string(body) != "{}" {
		var c config.Config
		if err := json.Unmarshal(body, &c); err != nil {
			s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
			return
		}
		draft = &c
	}

	var c *config.Config
	fromDraft := false
	configHash := ""
	if draft != nil {
		c = draft
		fromDraft = true
	} else {
		// One read, so the hash can only name the bytes this check evaluated.
		b, err := os.ReadFile(s.Config)
		if err != nil {
			s.logErr("validate load", err)
			s.jsonErr(w, http.StatusInternalServerError, "could not read configuration")
			return
		}
		loaded, err := config.Parse(b)
		if err != nil {
			s.logErr("validate load", err)
			s.jsonErr(w, http.StatusInternalServerError, "could not read configuration")
			return
		}
		c = loaded
		configHash = state.ConfigBytesSHA256(b)
	}

	res := apply.ValidateConfigWithWarnings(c, apply.LoadAppliedConfig(s.Config), clientIP, s.GeoIP, fromDraft)
	// POST /reload takes this as "I checked this file": a failed check is no such thing,
	// and a draft isn't what a reload would apply.
	if res.OK {
		res.ConfigHash = configHash
	}
	if !res.OK {
		w.WriteHeader(http.StatusBadRequest)
	}
	s.jsonOK(w, res)
}

func (s *Server) handleClientIP(w http.ResponseWriter, r *http.Request) {
	info := DetectClientIP(r)
	s.jsonOK(w, info)
}
