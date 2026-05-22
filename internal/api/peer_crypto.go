package api

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/imevul/evuproxy/internal/apply"
)

const maxPeerOnboardBundleBody = 8 << 10

func (s *Server) handlePeerGenerateKeypair(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		s.jsonErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	priv, pub, err := apply.GenerateWireGuardKeypair()
	if err != nil {
		s.logErr("peer-generate-keypair", err)
		s.jsonErr(w, http.StatusInternalServerError, "key generation failed (is wireguard-tools installed?)")
		return
	}
	s.jsonOK(w, map[string]string{
		"private_key": priv,
		"public_key":  pub,
	})
}

type peerOnboardBundleRequest struct {
	Passphrase      string `json:"passphrase"`
	PeerPrivateKey  string `json:"peer_private_key"`
	PeerTunnelAddr  string `json:"peer_tunnel_address"`
	ServerPublicKey string `json:"server_public_key"`
	Endpoint        string `json:"endpoint"`
	AllowedIPs      string `json:"allowed_ips"`
	InterfaceName   string `json:"interface_name"`
}

func (s *Server) handlePeerOnboardBundle(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		s.jsonErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, maxPeerOnboardBundleBody))
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "invalid body")
		return
	}
	var req peerOnboardBundleRequest
	if err := json.Unmarshal(body, &req); err != nil {
		s.jsonErr(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	req.Passphrase = strings.TrimSpace(req.Passphrase)
	req.PeerPrivateKey = strings.TrimSpace(req.PeerPrivateKey)
	req.PeerTunnelAddr = strings.TrimSpace(req.PeerTunnelAddr)
	req.ServerPublicKey = strings.TrimSpace(req.ServerPublicKey)
	req.Endpoint = strings.TrimSpace(req.Endpoint)
	req.AllowedIPs = strings.TrimSpace(req.AllowedIPs)
	req.InterfaceName = strings.TrimSpace(req.InterfaceName)
	if req.InterfaceName == "" {
		req.InterfaceName = "evuproxy"
	}
	if req.Passphrase == "" {
		s.jsonErr(w, http.StatusBadRequest, "passphrase required")
		return
	}
	blob, err := apply.EncryptPeerOnboardBundle(req.Passphrase, apply.PeerOnboardBundleParams{
		PeerPrivateKey:  req.PeerPrivateKey,
		PeerTunnelAddr:  req.PeerTunnelAddr,
		ServerPublicKey: req.ServerPublicKey,
		Endpoint:        req.Endpoint,
		AllowedIPs:      req.AllowedIPs,
		InterfaceName:   req.InterfaceName,
	})
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, err.Error())
		return
	}
	s.jsonOK(w, map[string]string{
		"blob_base64": base64.StdEncoding.EncodeToString(blob),
	})
}
