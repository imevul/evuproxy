package gen

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

const (
	logPrefixRateLimit = "evuproxy-ratelimit: "
	setRateLimitConn   = "ratelimit_conn_v4"
	setRateLimitSyn    = "ratelimit_syn_v4"
	setRateLimitUDP    = "ratelimit_udp_v4"
)

func rateLimitBurst(perSecond uint) uint {
	if perSecond < 5 {
		return perSecond * 2
	}
	if perSecond > 50 {
		return perSecond
	}
	return perSecond * 2
}

type rateLimitSetNeeds struct {
	globalConn bool
	globalSyn  bool
	globalUDP  bool
	routeConn  map[int]bool
	routeSyn   map[int]bool
	routeUDP   map[int]bool
}

func rateLimitSetNeedsFor(c *config.Config) rateLimitSetNeeds {
	var needs rateLimitSetNeeds
	needs.routeConn = map[int]bool{}
	needs.routeSyn = map[int]bool{}
	needs.routeUDP = map[int]bool{}
	g := c.Forwarding.RateLimit
	if g.MaxConnPerIP > 0 {
		needs.globalConn = true
	}
	if g.TCPSynPerSecond > 0 {
		needs.globalSyn = true
	}
	if g.UDPPerSecond > 0 {
		needs.globalUDP = true
	}
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		if r.RateLimit.MaxConnPerIP > 0 {
			needs.routeConn[i] = true
		} else if g.MaxConnPerIP > 0 {
			needs.globalConn = true
		}
		if r.RateLimit.TCPSynPerSecond > 0 {
			needs.routeSyn[i] = true
		} else if g.TCPSynPerSecond > 0 {
			needs.globalSyn = true
		}
		if r.RateLimit.UDPPerSecond > 0 {
			needs.routeUDP[i] = true
		} else if g.UDPPerSecond > 0 {
			needs.globalUDP = true
		}
	}
	return needs
}

func writeRateLimitSets(b *strings.Builder, needs rateLimitSetNeeds) {
	if needs.globalConn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n    }\n\n", setRateLimitConn)
	}
	if needs.globalSyn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", setRateLimitSyn)
	}
	if needs.globalUDP {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", setRateLimitUDP)
	}
	for i := range needs.routeConn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n    }\n\n", rateLimitConnSetRoute(i))
	}
	for i := range needs.routeSyn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", rateLimitSynSetRoute(i))
	}
	for i := range needs.routeUDP {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", rateLimitUDPSetRoute(i))
	}
}

type rateLimitBinding struct {
	connSet string
	connN   uint
	synSet  string
	synN    uint
	udpSet  string
	udpN    uint
}

func rateLimitBindingForRoute(routeIndex int, global, route config.RateLimit) rateLimitBinding {
	var b rateLimitBinding
	if route.MaxConnPerIP > 0 {
		b.connSet = rateLimitConnSetRoute(routeIndex)
		b.connN = route.MaxConnPerIP
	} else if global.MaxConnPerIP > 0 {
		b.connSet = setRateLimitConn
		b.connN = global.MaxConnPerIP
	}
	if route.TCPSynPerSecond > 0 {
		b.synSet = rateLimitSynSetRoute(routeIndex)
		b.synN = route.TCPSynPerSecond
	} else if global.TCPSynPerSecond > 0 {
		b.synSet = setRateLimitSyn
		b.synN = global.TCPSynPerSecond
	}
	if route.UDPPerSecond > 0 {
		b.udpSet = rateLimitUDPSetRoute(routeIndex)
		b.udpN = route.UDPPerSecond
	} else if global.UDPPerSecond > 0 {
		b.udpSet = setRateLimitUDP
		b.udpN = global.UDPPerSecond
	}
	return b
}

func rateLimitConnSetRoute(i int) string  { return fmt.Sprintf("ratelimit_conn_r%d", i) }
func rateLimitSynSetRoute(i int) string   { return fmt.Sprintf("ratelimit_syn_r%d", i) }
func rateLimitUDPSetRoute(i int) string   { return fmt.Sprintf("ratelimit_udp_r%d", i) }

// writePolicyRateLimit emits per-source limits on published ports (INPUT and forward).
func writePolicyRateLimit(b *strings.Builder, routeIndex int, global, route config.RateLimit, proto, portExpr, breakGlass string) {
	writePolicyRateLimitScoped(b, "", routeIndex, global, route, proto, portExpr, breakGlass)
}

// writePolicyForwardRateLimit emits per-source limits on WAN→tunnel forwarded flows.
func writePolicyForwardRateLimit(b *strings.Builder, pub, wg string, routeIndex int, global, route config.RateLimit, proto, portExpr, breakGlass string) {
	scope := fmt.Sprintf("iifname %q oifname %q ", pub, wg)
	writePolicyRateLimitScoped(b, scope, routeIndex, global, route, proto, portExpr, breakGlass)
}

func writePolicyRateLimitScoped(b *strings.Builder, scope string, routeIndex int, global, route config.RateLimit, proto, portExpr, breakGlass string) {
	rl := rateLimitBindingForRoute(routeIndex, global, route)
	if rl.connSet == "" && rl.synSet == "" && rl.udpSet == "" {
		return
	}
	exempt := rateLimitExemptPrefix(breakGlass)
	if rl.connSet != "" && rl.connN > 0 {
		fmt.Fprintf(b, "        %s%s%s dport %s ct state established,related update @%s { ip saddr } ct count over %d\n",
			scope, exempt, proto, portExpr, rl.connSet, rl.connN)
		fmt.Fprintf(b, "        %s%sip saddr @%s %s dport %s log prefix %q drop\n",
			scope, exempt, rl.connSet, proto, portExpr, logPrefixRateLimit)
	}
	if proto == "tcp" && rl.synSet != "" && rl.synN > 0 {
		burst := rateLimitBurst(rl.synN)
		fmt.Fprintf(b, "        %s%s%s dport %s tcp flags syn ct state new add @%s { ip saddr limit rate %d/second burst %d packets } log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.synSet, rl.synN, burst, logPrefixRateLimit)
	}
	if proto == "udp" && rl.udpSet != "" && rl.udpN > 0 {
		burst := rateLimitBurst(rl.udpN)
		fmt.Fprintf(b, "        %s%s%s dport %s ct state new add @%s { ip saddr limit rate %d/second burst %d packets } log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.udpSet, rl.udpN, burst, logPrefixRateLimit)
	}
}

// rateLimitExemptPrefix limits rules to sources outside break-glass (when configured).
func rateLimitExemptPrefix(breakGlass string) string {
	if breakGlass == "" {
		return ""
	}
	return fmt.Sprintf("ip saddr != @%s ", breakGlass)
}

// writePolicyForwardDrops emits global/route deny, CrowdSec, and rate limits on forward (before accept).
func writePolicyForwardDrops(b *strings.Builder, pub, wg string, routeIndex int, global, route config.RateLimit, proto, portExpr, srcDeny, crowdsecSet, breakGlass, globalDeny string) {
	if portExpr == "" {
		return
	}
	if globalDeny != "" {
		fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s %s dport %s drop\n", pub, wg, globalDeny, proto, portExpr)
	}
	if srcDeny != "" {
		fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s %s dport %s drop\n", pub, wg, srcDeny, proto, portExpr)
	}
	if crowdsecSet != "" {
		if breakGlass != "" {
			fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s ip saddr != @%s %s dport %s drop\n", pub, wg, crowdsecSet, breakGlass, proto, portExpr)
		} else {
			fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s %s dport %s drop\n", pub, wg, crowdsecSet, proto, portExpr)
		}
	}
	writePolicyForwardRateLimit(b, pub, wg, routeIndex, global, route, proto, portExpr, breakGlass)
}
