package api

import (
	"io"
	"net/http"
	"strconv"
	"strings"

	qrcode "github.com/skip2/go-qrcode"

	"github.com/imevul/evuproxy/internal/config"
)

const maxPeerQRConfBytes = 16 << 10

func (s *Server) handlePeerQR(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		if r.Method == http.MethodGet && strings.TrimSpace(r.URL.Query().Get("conf")) != "" {
			s.jsonErr(w, http.StatusBadRequest, "WireGuard config must be sent in POST body, not query string")
			return
		}
		w.Header().Set("Allow", http.MethodPost)
		s.jsonErr(w, http.StatusMethodNotAllowed, "POST required")
		return
	}
	idxStr := strings.TrimSpace(r.PathValue("index"))
	idx, err := strconv.Atoi(idxStr)
	if err != nil || idx < 0 {
		s.jsonErr(w, http.StatusBadRequest, "invalid peer index")
		return
	}
	c, err := config.Load(s.Config)
	if err != nil {
		s.logErr("peer qr load", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not read configuration")
		return
	}
	if idx >= len(c.Peers) {
		s.jsonErr(w, http.StatusNotFound, "peer not found")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxPeerQRConfBytes)
	defer r.Body.Close()
	b, err := io.ReadAll(r.Body)
	if err != nil {
		s.jsonErr(w, http.StatusBadRequest, "could not read request body")
		return
	}
	confText := strings.TrimSpace(string(b))
	if confText == "" {
		s.jsonErr(w, http.StatusBadRequest, "WireGuard client config text required in POST body")
		return
	}
	png, err := qrcode.Encode(confText, qrcode.Medium, 256)
	if err != nil {
		s.logErr("peer qr encode", err)
		s.jsonErr(w, http.StatusInternalServerError, "could not generate QR code")
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(png)
}
