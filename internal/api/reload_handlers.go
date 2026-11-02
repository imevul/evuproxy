package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
)

// readConfirmTimeout returns the optional confirm_timeout_seconds in a POST /reload body.
// Bodies were ignored before this field existed, so one that isn't a JSON object still
// means a plain reload. A malformed object is an error: guessing would apply one-way
// what the caller asked to be able to take back.
func readConfirmTimeout(r *http.Request) (int, error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 1<<14))
	if err != nil {
		return 0, err
	}
	if !bytes.HasPrefix(bytes.TrimSpace(raw), []byte("{")) {
		return 0, nil
	}
	var body struct {
		ConfirmTimeoutSeconds int `json:"confirm_timeout_seconds"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return 0, err
	}
	if t := body.ConfirmTimeoutSeconds; t != 0 && (t < config.MinConfirmTimeoutSeconds || t > config.MaxConfirmTimeoutSeconds) {
		return 0, fmt.Errorf("confirm_timeout_seconds must be %d to %d", config.MinConfirmTimeoutSeconds, config.MaxConfirmTimeoutSeconds)
	}
	return body.ConfirmTimeoutSeconds, nil
}

// confirmErrorCode maps a refusal to its status and stable code. ok is false for any other
// error, which is a reload that actually failed.
func confirmErrorCode(err error) (status int, code string, ok bool) {
	switch {
	case errors.Is(err, apply.ErrConfirmSessionActive):
		return http.StatusConflict, "apply_session_active", true
	case errors.Is(err, apply.ErrNoConfirmSession):
		return http.StatusConflict, "no_apply_session", true
	case errors.Is(err, apply.ErrRollbackFailed):
		return http.StatusConflict, "rollback_failed", true
	case errors.Is(err, apply.ErrNoConfirmBaseline):
		return http.StatusConflict, "no_baseline", true
	case errors.Is(err, apply.ErrConfirmUnavailable):
		return http.StatusConflict, "confirm_unavailable", true
	case errors.Is(err, apply.ErrNoRevertedConfig):
		return http.StatusConflict, "no_reverted_config", true
	case errors.Is(err, apply.ErrPendingEditsExist):
		return http.StatusConflict, "pending_edits", true
	}
	return 0, "", false
}

func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	timeout, err := readConfirmTimeout(r)
	if err != nil {
		s.jsonAPIError(w, http.StatusBadRequest, "invalid reload body: "+err.Error(), "invalid_reload_body")
		return
	}
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	detail := "reload"
	if timeout > 0 {
		detail = "reload, confirm within " + strconv.Itoa(timeout) + "s"
	}
	s.emit(eventlog.Record{Event: "reload_started", Detail: detail})
	// Detach from the request context: a client disconnect must not cancel the
	// privileged pipeline mid-way (nftables replaced but WireGuard/apply-state
	// not updated). The per-command 60s timeout still bounds individual hangs.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
	defer cancel()
	defer s.reloadStep.Store("")
	progress := func(step string) { s.reloadStep.Store(step) }
	var session *apply.ConfirmSessionView
	if timeout > 0 {
		session, err = apply.ReloadWithConfirm(ctx, s.Config, timeout, progress)
	} else {
		err = apply.ReloadWithProgress(ctx, s.Config, progress)
	}
	if err != nil {
		s.logErr("reload", err)
		if status, code, ok := confirmErrorCode(err); ok {
			s.emit(eventlog.Record{Event: "reload_failed", Detail: eventDetail(err.Error()), ErrorCode: code})
			s.jsonAPIError(w, status, err.Error(), code)
			return
		}
		s.emit(eventlog.Record{Event: "reload_failed", Detail: eventDetail(err.Error()), ErrorCode: "reload_error"})
		s.jsonErr(w, http.StatusInternalServerError, "reload failed")
		return
	}
	apply.InvalidateGeoSummaryCache()
	s.emit(eventlog.Record{Event: "reload_ok", Detail: detail})
	if session != nil {
		s.jsonOK(w, map[string]any{"result": "reloaded", "session": session})
		return
	}
	s.jsonOK(w, map[string]string{"result": "reloaded"})
}

func (s *Server) handleApplySession(w http.ResponseWriter, r *http.Request) {
	st, err := apply.ReadConfirmStatus(r.Context(), s.Config)
	if err != nil {
		s.logErr("apply session", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read apply session")
		return
	}
	s.jsonOK(w, st)
}

// confirmAction runs one session action under the apply lock, detached from the
// request for the same reason as handleReload. The actions emit their own events, so
// the CLI and the timer leave the same trail.
func (s *Server) confirmAction(w http.ResponseWriter, r *http.Request, name, result string, action func(ctx context.Context) error) {
	if !s.tryMutatingLock(w) {
		return
	}
	defer s.applyMu.Unlock()
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
	defer cancel()
	if err := action(ctx); err != nil {
		s.logErr(name, err)
		if status, code, ok := confirmErrorCode(err); ok {
			s.jsonAPIError(w, status, err.Error(), code)
			return
		}
		s.jsonErr(w, http.StatusInternalServerError, name+" failed")
		return
	}
	s.jsonOK(w, map[string]string{"result": result})
}

func (s *Server) handleApplyConfirm(w http.ResponseWriter, r *http.Request) {
	s.confirmAction(w, r, "apply confirm", "confirmed", func(ctx context.Context) error {
		return apply.ConfirmApply(ctx, s.Config)
	})
}

func (s *Server) handleApplyRevert(w http.ResponseWriter, r *http.Request) {
	s.confirmAction(w, r, "apply revert", "reverted", func(ctx context.Context) error {
		if err := apply.RevertApply(ctx, s.Config, apply.RevertReasonManual, ""); err != nil {
			return err
		}
		apply.InvalidateGeoSummaryCache()
		return nil
	})
}

func (s *Server) handleApplyRevertedRestore(w http.ResponseWriter, r *http.Request) {
	s.confirmAction(w, r, "restore reverted config", "restored", func(ctx context.Context) error {
		return apply.RestoreRevertedConfig(ctx, s.Config)
	})
}

func (s *Server) handleApplyRevertedDismiss(w http.ResponseWriter, r *http.Request) {
	s.confirmAction(w, r, "dismiss revert", "dismissed", func(ctx context.Context) error {
		return apply.DismissLastRevert(ctx, s.Config)
	})
}

// handleReloadProgress reports the stage of a running POST /reload, which only
// answers once it has finished. It takes no lock: that reload is holding it.
func (s *Server) handleReloadProgress(w http.ResponseWriter, r *http.Request) {
	step, _ := s.reloadStep.Load().(string)
	s.jsonOK(w, map[string]string{"step": step})
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
	heldBack, err := apply.UpdateGeo(ctx, s.Config)
	if err != nil {
		s.logErr("update-geo", err)
		if status, code, ok := confirmErrorCode(err); ok {
			s.emit(eventlog.Record{Event: "update_geo_failed", Detail: eventDetail(err.Error()), ErrorCode: code})
			s.jsonAPIError(w, status, err.Error(), code)
			return
		}
		s.emit(eventlog.Record{Event: "update_geo_failed", Detail: eventDetail(err.Error()), ErrorCode: "update_geo_error"})
		s.jsonErr(w, http.StatusInternalServerError, "geo update failed")
		return
	}
	apply.InvalidateGeoSummaryCache()
	s.emit(eventlog.Record{Event: "update_geo_ok", Detail: "update-geo"})
	s.jsonOK(w, map[string]any{"result": "geo_updated", "geo_changes_held_back": heldBack})
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
