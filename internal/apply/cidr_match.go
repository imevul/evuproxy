package apply

import (
	"net"
	"strings"
)

// IPv4ContainedInCIDRs reports whether ip is contained in any IPv4 address or CIDR entry.
func IPv4ContainedInCIDRs(ip string, cidrs []string) bool {
	parsed := net.ParseIP(strings.TrimSpace(ip))
	if parsed == nil || parsed.To4() == nil {
		return false
	}
	ip4 := parsed.To4()
	for _, raw := range cidrs {
		s := strings.TrimSpace(raw)
		if s == "" {
			continue
		}
		if strings.Contains(s, "/") {
			_, n, err := net.ParseCIDR(s)
			if err != nil || n == nil {
				continue
			}
			if n.Contains(ip4) {
				return true
			}
			continue
		}
		if host := net.ParseIP(s); host != nil && host.To4() != nil && host.To4().Equal(ip4) {
			return true
		}
	}
	return false
}
