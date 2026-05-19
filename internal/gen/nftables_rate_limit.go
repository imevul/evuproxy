package gen

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

const logPrefixRateLimit = "evuproxy-ratelimit: "

func rateLimitBurst(perSecond uint) uint {
	if perSecond < 5 {
		return perSecond * 2
	}
	if perSecond > 50 {
		return perSecond
	}
	return perSecond * 2
}

// rateLimitExemptPrefix limits rules to sources outside break-glass (when configured).
func rateLimitExemptPrefix(breakGlass string) string {
	if breakGlass == "" {
		return ""
	}
	return fmt.Sprintf("ip saddr != @%s ", breakGlass)
}

// writePolicyRateLimit emits per-source limits on published ports (INPUT and prerouting).
func writePolicyRateLimit(b *strings.Builder, rl config.RateLimit, proto, portExpr, breakGlass string) {
	writePolicyRateLimitScoped(b, "", rl, proto, portExpr, breakGlass)
}

// writePolicyForwardRateLimit emits per-source limits on WAN→tunnel forwarded flows.
func writePolicyForwardRateLimit(b *strings.Builder, pub, wg string, rl config.RateLimit, proto, portExpr, breakGlass string) {
	scope := fmt.Sprintf("iifname %q oifname %q ", pub, wg)
	writePolicyRateLimitScoped(b, scope, rl, proto, portExpr, breakGlass)
}

func writePolicyRateLimitScoped(b *strings.Builder, scope string, rl config.RateLimit, proto, portExpr, breakGlass string) {
	if !rl.Enabled() || portExpr == "" {
		return
	}
	exempt := rateLimitExemptPrefix(breakGlass)
	if rl.MaxConnPerIP > 0 {
		fmt.Fprintf(b, "        %s%s%s dport %s ct count ip saddr over %d packets log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.MaxConnPerIP, logPrefixRateLimit)
	}
	if proto == "tcp" && rl.TCPSynPerSecond > 0 {
		burst := rateLimitBurst(rl.TCPSynPerSecond)
		fmt.Fprintf(b, "        %s%s%s dport %s tcp flags syn / ct state new ip saddr limit rate %d/second burst %d packets log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.TCPSynPerSecond, burst, logPrefixRateLimit)
	}
	if proto == "udp" && rl.UDPPerSecond > 0 {
		burst := rateLimitBurst(rl.UDPPerSecond)
		fmt.Fprintf(b, "        %s%s%s dport %s ct state new ip saddr limit rate %d/second burst %d packets log prefix %q drop\n",
			scope, exempt, proto, portExpr, rl.UDPPerSecond, burst, logPrefixRateLimit)
	}
}

// writePolicyForwardDrops emits global/route deny, CrowdSec, and rate limits on forward (before accept).
func writePolicyForwardDrops(b *strings.Builder, pub, wg string, rl config.RateLimit, proto, portExpr, srcDeny, crowdsecSet, breakGlass, globalDeny string) {
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
	writePolicyForwardRateLimit(b, pub, wg, rl, proto, portExpr, breakGlass)
}
