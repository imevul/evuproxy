package api

import (
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/imevul/evuproxy/internal/state"
)

func (s *Server) handlePreferencesGet(w http.ResponseWriter, r *http.Request) {
	p, err := state.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("preferences get", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	s.jsonOK(w, p)
}

func (s *Server) handlePreferencesPut(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, 1<<14)
	defer r.Body.Close()
	var patch state.UIPreferencesPatch
	if err := json.NewDecoder(r.Body).Decode(&patch); err != nil {
		s.logErr("preferences decode", err)
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON body")
		return
	}
	cur, err := state.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("preferences load", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	out := state.ApplyUIPreferencesPatch(cur, &patch)
	if patch.PeerTunnelSubnetCIDR != nil && strings.TrimSpace(out.PeerTunnelSubnetCIDR) != "" {
		if _, _, err := net.ParseCIDR(out.PeerTunnelSubnetCIDR); err != nil {
			s.logErr("preferences cidr", err)
			s.jsonErr(w, http.StatusBadRequest, "invalid peer_tunnel_subnet_cidr")
			return
		}
	}
	out = state.NormalizeUIPreferences(out)
	if err := state.SaveUIPreferences(s.Config, &out); err != nil {
		s.logErr("preferences save", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not save preferences")
		return
	}
	reloaded, err := state.LoadUIPreferences(s.Config)
	if err != nil {
		s.logErr("preferences reload", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not load preferences")
		return
	}
	s.jsonOK(w, reloaded)
}
