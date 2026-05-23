package gen

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

const (
	logPrefixRateLimit = "evuproxy-ratelimit: "
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
	globalSyn bool
	globalUDP bool
	routeSyn  map[int]bool
	routeUDP  map[int]bool
}

func rateLimitSetNeedsFor(c *config.Config) rateLimitSetNeeds {
	var needs rateLimitSetNeeds
	needs.routeSyn = map[int]bool{}
	needs.routeUDP = map[int]bool{}
	g := c.Forwarding.RateLimit
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
	if needs.globalSyn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", setRateLimitSyn)
	}
	if needs.globalUDP {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", setRateLimitUDP)
	}
	for i := range needs.routeSyn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", rateLimitSynSetRoute(i))
	}
	for i := range needs.routeUDP {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n        timeout 2s\n    }\n\n", rateLimitUDPSetRoute(i))
	}
}

type rateLimitBinding struct {
	connN  uint
	synSet string
	synN   uint
	udpSet string
	udpN   uint
}

func rateLimitBindingForRoute(routeIndex int, global, route config.RateLimit) rateLimitBinding {
	var b rateLimitBinding
	if route.MaxConnPerIP > 0 {
		b.connN = route.MaxConnPerIP
	} else if global.MaxConnPerIP > 0 {
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
	if rl.connN == 0 && rl.synSet == "" && rl.udpSet == "" {
		return
	}
	exempt := rateLimitExemptPrefix(breakGlass)
	if rl.connN > 0 {
		// Inline ct count drop — no sticky dynamic set. The update+@set pattern permanently
		// banned sources and re-added them on keepalives from lingering conntrack entries.
		fmt.Fprintf(b, "        %s%s%s dport %s ct state established,related ct count over %d log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.connN, logPrefixRateLimit)
		if proto == "tcp" {
			fmt.Fprintf(b, "        %s%s%s dport %s ct state new ct count over %d log prefix %q drop\n",
				scope, exempt, proto, portExpr, rl.connN, logPrefixRateLimit)
		}
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
		writePolicyCrowdsecForwardDrop(b, pub, wg, crowdsecSet, breakGlass, proto, portExpr)
	}
	writePolicyForwardRateLimit(b, pub, wg, routeIndex, global, route, proto, portExpr, breakGlass)
}
