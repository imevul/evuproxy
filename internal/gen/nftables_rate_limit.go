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
	conn      []string
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
		if r.RateLimit.MaxConnPerIP > 0 || g.MaxConnPerIP > 0 {
			// A bad proto is reported by the rule generation, which needs the same parse.
			protos, _ := config.ParseRouteProtocols(r.Proto)
			for _, p := range protos {
				needs.conn = append(needs.conn, rateLimitConnSet(i, p))
			}
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
	// No timeout: an element holds the source's live connections, and the kernel drops it once
	// they have all closed.
	for _, name := range needs.conn {
		fmt.Fprintf(b, "    set %s {\n        type ipv4_addr\n        flags dynamic\n    }\n\n", name)
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

func rateLimitSynSetRoute(i int) string { return fmt.Sprintf("ratelimit_syn_r%d", i) }
func rateLimitUDPSetRoute(i int) string { return fmt.Sprintf("ratelimit_udp_r%d", i) }

// rateLimitConnSet is per route and protocol, so max_conn_per_ip counts a source's flows to that
// route, whether the limit is global or the route's own.
func rateLimitConnSet(i int, proto string) string {
	return fmt.Sprintf("ratelimit_conn_r%d_%s", i, proto)
}

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
		// The set is what makes the count per source: a bare "ct count" is one count for the
		// whole rule. The new connection is already in the count, so "over N" lets N through.
		// Not a sticky ban, because the count falls as connections close.
		connSet := rateLimitConnSet(routeIndex, proto)
		fmt.Fprintf(b, "        %s%s%s dport %s ct state established,related add @%s { ip saddr ct count over %d } log prefix %q drop\n",
			scope, exempt, proto, portExpr, connSet, rl.connN, logPrefixRateLimit)
		// Also on new UDP flows: one let through here would stay in the count and push the
		// source's working flows over the limit too.
		fmt.Fprintf(b, "        %s%s%s dport %s ct state new add @%s { ip saddr ct count over %d } log prefix %q drop\n",
			scope, exempt, proto, portExpr, connSet, rl.connN, logPrefixRateLimit)
	}
	// "over" is what makes these drop the excess: a bare "limit rate" matches traffic under the
	// rate. "update" restarts the 2s timeout on every packet, because "add" lets the element
	// expire under load and hands the source a fresh burst each time.
	if proto == "tcp" && rl.synSet != "" && rl.synN > 0 {
		burst := rateLimitBurst(rl.synN)
		fmt.Fprintf(b, "        %s%s%s dport %s tcp flags syn ct state new update @%s { ip saddr limit rate over %d/second burst %d packets } log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.synSet, rl.synN, burst, logPrefixRateLimit)
	}
	if proto == "udp" && rl.udpSet != "" && rl.udpN > 0 {
		burst := rateLimitBurst(rl.udpN)
		// Meter every UDP datagram — ct state new only matches the first packet of a flow;
		// established UDP would skip this rule and hit blanket established,related accept.
		fmt.Fprintf(b, "        %s%s%s dport %s update @%s { ip saddr limit rate over %d/second burst %d packets } log prefix %q drop\n",
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
func writePolicyForwardDrops(b *strings.Builder, pub, wg string, r routePolicy) {
	if r.forwardPorts == "" {
		return
	}
	if r.globalDeny != "" {
		fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s %s dport %s drop\n", pub, wg, r.globalDeny, r.proto, r.forwardPorts)
	}
	if r.srcDeny != "" {
		fmt.Fprintf(b, "        iifname %q oifname %q ip saddr @%s %s dport %s drop\n", pub, wg, r.srcDeny, r.proto, r.forwardPorts)
	}
	if r.crowdsecSet != "" {
		writePolicyCrowdsecForwardDrop(b, pub, wg, r.crowdsecSet, r.breakGlass, r.proto, r.forwardPorts)
	}
	writePolicyForwardRateLimit(b, pub, wg, r.routeIndex, r.globalRL, r.routeRL, r.proto, r.forwardPorts, r.breakGlass)
}
