package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
)

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	s.emit(eventlog.Record{Event: "reload_started", Detail: "reload"})
	// Detach from the request context: a client disconnect must not cancel the
	// privileged pipeline mid-way (nftables replaced but WireGuard/apply-state
	// not updated). The per-command 60s timeout still bounds individual hangs.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
	defer cancel()
	if err := apply.Reload(ctx, s.Config); err != nil {
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
	// Detached from the request context (see handleReload); zone downloads for
	// many countries are slow, so allow a longer overall budget.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Minute)
	defer cancel()
	if err := apply.UpdateGeo(ctx, s.Config); err != nil {
		s.logErr("update-geo", err)
		s.emit(eventlog.Record{Event: "update_geo_failed", Detail: eventDetail(err.Error()), ErrorCode: "update_geo_error"})
		s.jsonErr(w, http.StatusInternalServerError, "geo update failed")
		return
	}
	apply.InvalidateGeoSummaryCache()
	s.emit(eventlog.Record{Event: "update_geo_ok", Detail: "update-geo"})
	s.jsonOK(w, map[string]string{"result": "geo_updated"})
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
	switch {
	case errors.Is(err, apply.ErrRouteIndexInvalid):
		return "invalid route index"
	case errors.Is(err, apply.ErrRouteDisabled):
		return "route is disabled"
	case errors.Is(err, apply.ErrRouteNoPorts):
		return "route has no ports"
	case errors.Is(err, apply.ErrRoutePortNotFound):
		return "port not in route"
	case errors.Is(err, apply.ErrRouteTargetIP):
		return "invalid target IP"
	case errors.Is(err, apply.ErrRouteInvalidProto):
		return "invalid route protocol"
	default:
		return "route test failed"
	}
}
