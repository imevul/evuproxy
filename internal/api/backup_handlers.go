package api

import (
	"context"
	"net/http"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/eventlog"
)

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
	// Detached from the request context so a client disconnect cannot kill tar
	// mid-write and leave a truncated archive at the destination.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Minute)
	defer cancel()
	if err := apply.Backup(ctx, s.Config, path); err != nil {
		s.logErr("backup", err)
		s.emit(eventlog.Record{Event: "backup_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusInternalServerError, "backup failed")
		return
	}
	s.emit(eventlog.Record{Event: "backup_ok", Detail: eventDetail(path)})
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
		s.emit(eventlog.Record{Event: "restore_failed", Detail: eventDetail(err.Error())})
		s.jsonErr(w, http.StatusInternalServerError, "restore failed")
		return
	}
	s.emit(eventlog.Record{Event: "restore_ok", Detail: eventDetail(path)})
	s.jsonOK(w, map[string]string{"result": "restored", "hint": "run evuproxy reload"})
}
