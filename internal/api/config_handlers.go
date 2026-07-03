package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"os"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/state"
)

// Limits JSON body for PUT /config/notes (text is capped separately in state.SaveConfigNotes).
const configNotesMaxBody = 264 << 10

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

func (s *Server) handleConfigNotesGet(w http.ResponseWriter, r *http.Request) {
	text, err := state.LoadConfigNotes(s.Config)
	if err != nil {
		s.logErr("config notes get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read notes")
		return
	}
	s.jsonOK(w, map[string]string{"text": text})
}

func (s *Server) handleConfigNotesPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, configNotesMaxBody)
	defer r.Body.Close()
	var body struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			s.jsonErr(w, http.StatusRequestEntityTooLarge, "request body too large")
			return
		}
		s.logErr("config notes decode", err)
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	if err := state.SaveConfigNotes(s.Config, body.Text); err != nil {
		s.logErr("config notes save", err)
		if errors.Is(err, state.ErrNotesTooLarge) {
			s.jsonErr(w, http.StatusBadRequest, err.Error())
			return
		}
		s.jsonErr(w, http.StatusInternalServerError, "could not save notes")
		return
	}
	s.emit(eventlog.Record{Event: "config_notes_saved", Detail: "notes updated"})
	s.jsonOK(w, map[string]string{"result": "saved"})
}
