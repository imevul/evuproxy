package apply

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// lookupIPFn resolves hostnames; overridable in tests.
var lookupIPFn = lookupIPWithTimeout

// hostPublicAddrsFn returns this host's candidate public IPs; overridable in tests.
var hostPublicAddrsFn = collectHostPublicAddrs

const endpointDNSTimeout = 3 * time.Second

func lookupIPWithTimeout(host string) ([]net.IP, error) {
	ctx, cancel := context.WithTimeout(context.Background(), endpointDNSTimeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	out := make([]net.IP, 0, len(addrs))
	for _, a := range addrs {
		if a.IP != nil {
			out = append(out, a.IP)
		}
	}
	return out, nil
}

// Well-known Cloudflare prefixes for a clearer warning (not a full CF IP list).
var cloudflareHintNets = mustParseCIDRs(
	"104.16.0.0/13",
	"172.64.0.0/13",
	"2606:4700::/32",
)

func mustParseCIDRs(cidrs ...string) []*net.IPNet {
	out := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			panic(err)
		}
		out = append(out, n)
	}
	return out
}

// endpointHostWarnings compares wireguard_server_endpoint DNS/IP to this host's public addresses.
func endpointHostWarnings(ctx context.Context, cfgPath string, c *config.Config) []WireGuardHostWarning {
	if c == nil || strings.TrimSpace(cfgPath) == "" {
		return nil
	}
	prefs, err := state.LoadUIPreferences(cfgPath)
	if err != nil {
		return nil
	}
	raw := strings.TrimSpace(prefs.WireGuardServerEndpoint)
	if raw == "" {
		return nil
	}
	host, _, err := splitEndpointHostPort(raw)
	if err != nil || host == "" {
		return []WireGuardHostWarning{{
			Code:    "wg_endpoint_host_mismatch",
			Message: "WireGuard server endpoint " + quoteEP(raw) + " could not be parsed as host:port.",
		}}
	}

	candidates, err := hostPublicAddrsFn(ctx, strings.TrimSpace(c.Network.PublicInterface))
	if err != nil || len(candidates) == 0 {
		return nil // cannot compare
	}
	candSet := makeIPSet(candidates)

	hostOnlyPrivate := allRFCPrivate(candidates)

	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsUnspecified() {
			return nil
		}
		if inCloudflareHint(ip) {
			return []WireGuardHostWarning{{
				Code: "wg_endpoint_host_mismatch",
				Message: fmt.Sprintf(
					"WireGuard server endpoint %s uses IP %s, which looks like Cloudflare anycast. "+
						"WireGuard UDP cannot traverse the orange-cloud proxy — use this VPS public IP or a grey-cloud / DNS-only name.",
					quoteEP(raw), ip.String(),
				),
			}}
		}
		// When the NIC only has RFC1918/ULA addresses (NAT/EIP), skip literal mismatch —
		// the stored public EIP often will not appear on the interface.
		if hostOnlyPrivate {
			return nil
		}
		if !candSet.contains(ip) {
			msg := fmt.Sprintf(
				"WireGuard server endpoint %s uses IP %s, which is not among this host's public addresses (%s). "+
					"Peer configs will dial the wrong target. Set the endpoint to this VPS's public IP (or a DNS name that resolves only to it).",
				quoteEP(raw), ip.String(), joinIPs(candidates),
			)
			return []WireGuardHostWarning{{Code: "wg_endpoint_host_mismatch", Message: msg}}
		}
		return nil
	}

	resolved, err := lookupIPFn(host)
	if err != nil {
		return []WireGuardHostWarning{{
			Code: "wg_endpoint_dns_lookup_failed",
			Message: fmt.Sprintf(
				"Could not resolve WireGuard server endpoint host %q: %v. Peer onboarding may bake in a bad Endpoint.",
				host, err,
			),
		}}
	}
	if len(resolved) == 0 {
		return []WireGuardHostWarning{{
			Code:    "wg_endpoint_dns_lookup_failed",
			Message: fmt.Sprintf("WireGuard server endpoint host %q resolved to no addresses.", host),
		}}
	}

	var foreign []net.IP
	cfHit := false
	for _, ip := range resolved {
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		if !candSet.contains(ip) {
			foreign = append(foreign, ip)
		}
		if inCloudflareHint(ip) {
			cfHit = true
		}
	}
	if cfHit {
		msg := fmt.Sprintf(
			"WireGuard server endpoint %s resolves to %s (includes Cloudflare anycast). "+
				"Peer install snippets will dial Cloudflare, not this VPS (clients often prefer AAAA → 0 B received). "+
				"Use this VPS public IP:port, or disable orange-cloud (DNS only / grey-cloud) for that hostname.",
			quoteEP(raw), joinIPs(resolved),
		)
		return []WireGuardHostWarning{{Code: "wg_endpoint_host_mismatch", Message: msg}}
	}
	if hostOnlyPrivate || len(foreign) == 0 {
		return nil
	}

	msg := fmt.Sprintf(
		"WireGuard server endpoint %s resolves to %s, but this host's public addresses are %s. "+
			"Peer install snippets will use the wrong Endpoint (clients often prefer AAAA). "+
			"Use this VPS's public IP:port, or a DNS name that resolves only to this host.",
		quoteEP(raw), joinIPs(resolved), joinIPs(candidates),
	)
	return []WireGuardHostWarning{{Code: "wg_endpoint_host_mismatch", Message: msg}}
}

func splitEndpointHostPort(raw string) (host, port string, err error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", fmt.Errorf("empty")
	}
	// host:port or [v6]:port
	if strings.HasPrefix(raw, "[") {
		h, p, e := net.SplitHostPort(raw)
		return h, p, e
	}
	if strings.Count(raw, ":") == 1 {
		return net.SplitHostPort(raw)
	}
	// bare host or bare v6 without brackets/port
	if ip := net.ParseIP(raw); ip != nil {
		return raw, "", nil
	}
	if strings.Contains(raw, ":") {
		// ambiguous v6 without brackets — treat whole string as host
		return raw, "", nil
	}
	return raw, "", nil
}

func collectHostPublicAddrs(ctx context.Context, pubIF string) ([]net.IP, error) {
	seen := map[string]net.IP{}
	add := func(ip net.IP) {
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
			return
		}
		seen[ip.String()] = ip
	}

	if pubIF != "" {
		for _, fam := range []string{"-4", "-6"} {
			out, err := runCmdCombined(ctx, "ip", fam, "-o", "addr", "show", "dev", pubIF, "scope", "global")
			if err != nil {
				continue
			}
			parseIPAddrShow(string(out), add)
		}
	}

	if out, err := runCmdCombined(ctx, "ip", "-4", "route", "get", "1.1.1.1"); err == nil {
		if ip := parseRouteGetSrc(string(out)); ip != nil {
			add(ip)
		}
	}
	if out, err := runCmdCombined(ctx, "ip", "-6", "route", "get", "2606:4700:4700::1111"); err == nil {
		if ip := parseRouteGetSrc(string(out)); ip != nil {
			add(ip)
		}
	}

	out := make([]net.IP, 0, len(seen))
	for _, ip := range seen {
		out = append(out, ip)
	}
	return out, nil
}

func parseIPAddrShow(s string, add func(net.IP)) {
	// 2: eth0    inet 203.0.113.1/24 ...
	for _, line := range strings.Split(s, "\n") {
		fields := strings.Fields(line)
		for i := 0; i < len(fields)-1; i++ {
			if fields[i] == "inet" || fields[i] == "inet6" {
				cidr := fields[i+1]
				ip, _, err := net.ParseCIDR(cidr)
				if err != nil {
					ip = net.ParseIP(cidr)
				}
				if ip != nil {
					add(ip)
				}
			}
		}
	}
}

func parseRouteGetSrc(s string) net.IP {
	fields := strings.Fields(s)
	for i := 0; i < len(fields)-1; i++ {
		if fields[i] == "src" {
			return net.ParseIP(fields[i+1])
		}
	}
	return nil
}

type ipSet map[string]struct{}

func makeIPSet(ips []net.IP) ipSet {
	s := make(ipSet, len(ips))
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		s[ip.String()] = struct{}{}
		if v4 := ip.To4(); v4 != nil {
			s[v4.String()] = struct{}{}
		}
	}
	return s
}

func (s ipSet) contains(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if _, ok := s[ip.String()]; ok {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		_, ok := s[v4.String()]
		return ok
	}
	return false
}

func inCloudflareHint(ip net.IP) bool {
	for _, n := range cloudflareHintNets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

func allRFCPrivate(ips []net.IP) bool {
	if len(ips) == 0 {
		return true
	}
	for _, ip := range ips {
		if ip == nil {
			continue
		}
		if !ip.IsPrivate() && !ip.IsLoopback() && !ip.IsLinkLocalUnicast() {
			return false
		}
	}
	return true
}

func joinIPs(ips []net.IP) string {
	parts := make([]string, 0, len(ips))
	for _, ip := range ips {
		if ip != nil {
			parts = append(parts, ip.String())
		}
	}
	if len(parts) == 0 {
		return "(none)"
	}
	return strings.Join(parts, ", ")
}

func quoteEP(s string) string {
	return fmt.Sprintf("%q", s)
}
