package gen

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

const (
	setBreakGlass = "break_glass_v4"
	setGlobalDeny = "global_src_deny_v4"
)

func routeDenySetName(routeIndex int) string {
	return fmt.Sprintf("route_deny_%d", routeIndex)
}

func routeGeoSetName(routeIndex int) string {
	return fmt.Sprintf("route_geo_%d", routeIndex)
}

type routeDNATLine struct {
	publicDport string
	dnatTo      string
}

// routePolicy bundles everything the policy writers need to emit rules for one
// route+protocol pairing: the per-route matching parameters plus the global
// scoping sets (CrowdSec, break-glass, global deny) that apply to every route.
type routePolicy struct {
	routeIndex int
	proto      string
	portExpr   string
	// forwardPorts is what portExpr looks like in the forward chain, after DNAT.
	forwardPorts string
	target       string
	srcAllow     string // route source-allow set name, "" = any source
	srcDeny      string // route source-deny set name, "" = none
	geo          routeGeoParams
	globalRL     config.RateLimit
	routeRL      config.RateLimit
	dnat         []routeDNATLine
	// Global sets shared by all routes ("" when the feature is off).
	crowdsecSet string
	breakGlass  string
	globalDeny  string
	counter     string // dropCounter statement, "" = stats.drop_counters off
}

func buildRouteDNATLines(r config.ForwardRoute) ([]routeDNATLine, error) {
	var lines []routeDNATLine
	target := strings.TrimSpace(r.TargetIP)
	for _, tok := range normalizedPortTokensFromPorts(r.Ports) {
		pairs, err := config.RangePortPairs(tok, r.PortMaps)
		if err != nil {
			return nil, err
		}
		if pairs != nil {
			for _, p := range pairs {
				lines = append(lines, routeDNATLine{publicDport: fmt.Sprint(p.Public), dnatTo: fmt.Sprintf("%s:%d", target, p.Internal)})
			}
			continue
		}
		to, err := config.DNATDestination(r.TargetIP, tok, r.PortMaps)
		if err != nil {
			return nil, err
		}
		lines = append(lines, routeDNATLine{publicDport: tok, dnatTo: to})
	}
	return lines, nil
}

// routeForwardPorts returns the port match for a route in the forward chain, given its public
// port expression. Prerouting has already rewritten a mapped port by then, so the packet carries
// the internal port. Conntrack still knows the public one, and requiring both keeps the internal
// port closed to anything that didn't come through this route's DNAT.
func routeForwardPorts(r config.ForwardRoute, publicExpr string) (string, error) {
	if len(r.PortMaps) == 0 {
		return publicExpr, nil
	}
	var internal []string
	for _, tok := range normalizedPortTokensFromPorts(r.Ports) {
		internal = append(internal, config.InternalPort(tok, r.PortMaps))
	}
	internalExpr, err := formatPortSets(internal)
	if err != nil {
		return "", err
	}
	return internalExpr + " ct original proto-dst " + publicExpr, nil
}

func normalizedPortTokensFromPorts(ports []string) []string {
	var out []string
	for _, raw := range ports {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			out = append(out, raw)
		}
	}
	return out
}

type routeGeoParams struct {
	enabled     bool
	blockListed bool
	setName     string
}

func routeGeoParamsFor(c *config.Config, routeIndex int, r config.ForwardRoute) (routeGeoParams, error) {
	mode := strings.ToLower(strings.TrimSpace(r.GeoMode))
	if mode == "" {
		mode = config.RouteGeoInherit
	}
	if mode == config.RouteGeoOff {
		return routeGeoParams{}, nil
	}
	if mode == config.RouteGeoCustom {
		if !c.Geo.Enabled {
			return routeGeoParams{}, nil
		}
		block := strings.EqualFold(strings.TrimSpace(c.Geo.Mode), "block")
		return routeGeoParams{enabled: true, blockListed: block, setName: routeGeoSetName(routeIndex)}, nil
	}
	// inherit
	if !c.Geo.Enabled {
		return routeGeoParams{}, nil
	}
	block := strings.EqualFold(strings.TrimSpace(c.Geo.Mode), "block")
	return routeGeoParams{enabled: true, blockListed: block, setName: c.Geo.EffectiveSetName()}, nil
}

func writeBreakGlassSet(b *strings.Builder, elems []string) {
	if len(elems) == 0 {
		return
	}
	writeRouteSrcSet(b, setBreakGlass, elems)
}

func writeGlobalDenySet(b *strings.Builder, elems []string) {
	if len(elems) == 0 {
		return
	}
	writeRouteSrcSet(b, setGlobalDeny, elems)
}

func writeRouteDenySets(b *strings.Builder, c *config.Config) error {
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		elems := normalizedRouteSourceElems(r.SourceDenyCIDRs)
		if len(elems) == 0 {
			continue
		}
		if err := config.ValidateSourceDenyCIDRs(i, r.SourceDenyCIDRs); err != nil {
			return err
		}
		writeRouteSrcSet(b, routeDenySetName(i), elems)
	}
	return nil
}

// writeRouteCustomGeoSets declares the per-route custom geo sets empty; the geo
// loader file populates them at apply time (mirroring the global geo set). This
// keeps table rendering free of zone-file reads, so previews (GET /pending)
// cannot fail on missing zone data, and avoids duplicating tens of thousands of
// CIDRs inline in both tables.
func writeRouteCustomGeoSets(b *strings.Builder, c *config.Config) {
	if !c.Geo.Enabled {
		return
	}
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		if strings.ToLower(strings.TrimSpace(r.GeoMode)) != config.RouteGeoCustom {
			continue
		}
		writeGeoSet(b, routeGeoSetName(i))
	}
}

func writePolicyDnatLine(b *strings.Builder, r routePolicy, line routeDNATLine) {
	if line.publicDport == "" || line.dnatTo == "" {
		return
	}
	if r.globalDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %sdrop\n", r.globalDeny, r.proto, line.publicDport, r.counter)
	}
	if r.srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %sdrop\n", r.srcDeny, r.proto, line.publicDport, r.counter)
	}
	dnatVerdict := "dnat to " + line.dnatTo
	if !r.geo.enabled {
		writePolicyAllow(b, r.proto, line.publicDport, r.srcAllow, "", dnatVerdict)
		return
	}
	if r.geo.blockListed {
		writePolicyGeoBlockDrop(b, r.geo.setName, r.breakGlass, r.proto, line.publicDport, r.counter)
		writePolicyAllow(b, r.proto, line.publicDport, r.srcAllow, "", dnatVerdict)
		return
	}
	writePolicyAllow(b, r.proto, line.publicDport, r.srcAllow, r.geo.setName, dnatVerdict)
	if r.breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s dnat to %s\n", r.breakGlass, r.proto, line.publicDport, line.dnatTo)
	}
}

// writePolicyAllow emits a single "<match> <proto> dport <ports> <verdict>" rule,
// optionally scoped by a source-allow set and/or a geo set. verdict is the nft
// terminal statement, e.g. "accept" or "dnat to 10.0.0.2:80". Shared by the INPUT
// and NAT-prerouting policy writers so the four match permutations are defined once.
func writePolicyAllow(b *strings.Builder, proto, portExpr, srcAllow, geoSet, verdict string) {
	switch {
	case geoSet != "" && srcAllow != "":
		fmt.Fprintf(b, "        ip saddr @%s ip saddr @%s %s dport %s %s\n", srcAllow, geoSet, proto, portExpr, verdict)
	case geoSet != "":
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %s\n", geoSet, proto, portExpr, verdict)
	case srcAllow != "":
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %s\n", srcAllow, proto, portExpr, verdict)
	default:
		fmt.Fprintf(b, "        %s dport %s %s\n", proto, portExpr, verdict)
	}
}

func writePolicyGeoBlockDrop(b *strings.Builder, geoSet, breakGlass, proto, portExpr, counter string) {
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s %sdrop\n", geoSet, breakGlass, proto, portExpr, counter)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s %sdrop\n", geoSet, proto, portExpr, counter)
}

func writePolicyInputPort(b *strings.Builder, r routePolicy) {
	if r.portExpr == "" {
		return
	}
	if r.globalDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %sdrop\n", r.globalDeny, r.proto, r.portExpr, r.counter)
	}
	if r.srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s %sdrop\n", r.srcDeny, r.proto, r.portExpr, r.counter)
	}
	writePolicyCrowdsecDrop(b, r.crowdsecSet, r.breakGlass, r.proto, r.portExpr, r.counter)
	writePolicyRateLimit(b, r.routeIndex, r.globalRL, r.routeRL, r.proto, r.portExpr, r.breakGlass, r.counter)
	if !r.geo.enabled {
		writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, "", "accept")
		return
	}
	if r.geo.blockListed {
		writePolicyGeoBlockDropLogged(b, r.geo.setName, r.breakGlass, r.proto, r.portExpr, r.counter)
		writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, "", "accept")
		return
	}
	writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, r.geo.setName, "accept")
	if r.breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s accept\n", r.breakGlass, r.proto, r.portExpr)
		return
	}
	writeGeoLogDrop(b, fmt.Sprintf("%s dport %s ip saddr != @%s", r.proto, r.portExpr, r.geo.setName), r.counter)
}

func writePolicyGeoBlockDropLogged(b *strings.Builder, geoSet, breakGlass, proto, portExpr, counter string) {
	if breakGlass != "" {
		writeGeoLogDrop(b, fmt.Sprintf("ip saddr @%s ip saddr != @%s %s dport %s", geoSet, breakGlass, proto, portExpr), counter)
		return
	}
	writeGeoLogDrop(b, fmt.Sprintf("ip saddr @%s %s dport %s", geoSet, proto, portExpr), counter)
}

// writeGeoLogDrop logs a sample of what match catches and drops all of it. The limit needs a rule
// of its own: past the limit a limit statement stops the rule matching, and the packet would go
// on to whatever accept comes next.
func writeGeoLogDrop(b *strings.Builder, match, counter string) {
	fmt.Fprintf(b, "        %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \"\n", match)
	fmt.Fprintf(b, "        %s %sdrop\n", match, counter)
}
