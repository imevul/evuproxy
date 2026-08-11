package api

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
)

func (s *Server) handleDiagnosticsMD(w http.ResponseWriter, r *http.Request) {
	rateKey := bearerTokenFromRequest(r)
	if rateKey == "" {
		rateKey = "."
	}
	if !s.diagRL.allow(rateKey, 10, 0, time.Minute) {
		s.jsonAPIError(w, http.StatusTooManyRequests, "rate limit exceeded for diagnostics download", "rate_limit")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	ver := strings.TrimSpace(s.Version)
	if ver == "" {
		ver = "dev"
	}
	md, filename, err := apply.BuildDiagnosticsMarkdown(ctx, s.Config, apply.DiagnosticsMeta{
		Version:     ver,
		GeneratedAt: time.Now().UTC(),
	})
	if err != nil {
		s.logErr("diagnostics", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not build diagnostics report")
		return
	}
	if filename == "" {
		filename = "evuproxy-diagnostics.md"
	}
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filename+`"`)
	w.Header().Set("Content-Length", strconv.Itoa(len(md)))
	_, _ = w.Write(md)
}
