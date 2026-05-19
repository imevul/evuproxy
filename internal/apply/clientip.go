package apply

import (
	"net"
	"net/http"
	"os"
	"strings"
)

const (
	ClientIPSourceDirect      = "direct"
	ClientIPSourceXFF         = "xff"
	ClientIPSourceUnavailable = "unavailable"
)

// ClientIPInfo describes how the API inferred the operator's IPv4 address.
type ClientIPInfo struct {
	IP     string `json:"detected_client_ip,omitempty"`
	Source string `json:"ip_detection_source"`
	Note   string `json:"ip_detection_note,omitempty"`
}

// TrustXFF reports whether X-Forwarded-For is honored (EVUPROXY_TRUST_XFF=1|true|yes).
func TrustXFF() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("EVUPROXY_TRUST_XFF")))
	return v == "1" || v == "true" || v == "yes"
}

// DetectClientIP returns the best-effort IPv4 address for lockout warnings.
func DetectClientIP(r *http.Request) ClientIPInfo {
	if r == nil {
		return ClientIPInfo{Source: ClientIPSourceUnavailable, Note: "no request context"}
	}
	if TrustXFF() {
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			first := strings.TrimSpace(strings.Split(xff, ",")[0])
			if ip := parseIPv4Literal(first); ip != "" {
				return ClientIPInfo{
					IP:     ip,
					Source: ClientIPSourceXFF,
					Note:   "first hop from X-Forwarded-For (EVUPROXY_TRUST_XFF enabled)",
				}
			}
		}
	}
	host := strings.TrimSpace(r.RemoteAddr)
	if h, _, err := net.SplitHostPort(r.RemoteAddr); err == nil {
		host = strings.TrimSpace(h)
	}
	if ip := parseIPv4Literal(host); ip != "" {
		note := ""
		if !TrustXFF() && strings.TrimSpace(r.Header.Get("X-Forwarded-For")) != "" {
			note = "X-Forwarded-For present but ignored; set EVUPROXY_TRUST_XFF=1 only behind a trusted reverse proxy"
		}
		return ClientIPInfo{IP: ip, Source: ClientIPSourceDirect, Note: note}
	}
	return ClientIPInfo{Source: ClientIPSourceUnavailable, Note: "could not determine IPv4 client address"}
}

func parseIPv4Literal(s string) string {
	ip := net.ParseIP(strings.TrimSpace(s))
	if ip == nil || ip.To4() == nil {
		return ""
	}
	return ip.To4().String()
}
