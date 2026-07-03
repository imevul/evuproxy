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
	target     string
	srcAllow   string // route source-allow set name, "" = any source
	srcDeny    string // route source-deny set name, "" = none
	geo        routeGeoParams
	globalRL   config.RateLimit
	routeRL    config.RateLimit
	dnat       []routeDNATLine
	// Global sets shared by all routes ("" when the feature is off).
	crowdsecSet string
	breakGlass  string
	globalDeny  string
}

func buildRouteDNATLines(r config.ForwardRoute) ([]routeDNATLine, error) {
	var lines []routeDNATLine
	for _, tok := range normalizedPortTokensFromPorts(r.Ports) {
		to, err := config.DNATDestination(r.TargetIP, tok, r.PortMaps)
		if err != nil {
			return nil, err
		}
		lines = append(lines, routeDNATLine{publicDport: tok, dnatTo: to})
	}
	return lines, nil
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
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", r.globalDeny, r.proto, line.publicDport)
	}
	if r.srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", r.srcDeny, r.proto, line.publicDport)
	}
	dnatVerdict := "dnat to " + line.dnatTo
	if !r.geo.enabled {
		writePolicyAllow(b, r.proto, line.publicDport, r.srcAllow, "", dnatVerdict)
		return
	}
	if r.geo.blockListed {
		writePolicyGeoBlockDrop(b, r.geo.setName, r.breakGlass, r.proto, line.publicDport)
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

func writePolicyGeoBlockDrop(b *strings.Builder, geoSet, breakGlass, proto, portExpr string) {
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s drop\n", geoSet, breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", geoSet, proto, portExpr)
}

func writePolicyInputPort(b *strings.Builder, r routePolicy) {
	if r.portExpr == "" {
		return
	}
	if r.globalDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", r.globalDeny, r.proto, r.portExpr)
	}
	if r.srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", r.srcDeny, r.proto, r.portExpr)
	}
	writePolicyCrowdsecDrop(b, r.crowdsecSet, r.breakGlass, r.proto, r.portExpr)
	writePolicyRateLimit(b, r.routeIndex, r.globalRL, r.routeRL, r.proto, r.portExpr, r.breakGlass)
	if !r.geo.enabled {
		writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, "", "accept")
		return
	}
	if r.geo.blockListed {
		writePolicyGeoBlockDropLogged(b, r.geo.setName, r.breakGlass, r.proto, r.portExpr)
		writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, "", "accept")
		return
	}
	writePolicyAllow(b, r.proto, r.portExpr, r.srcAllow, r.geo.setName, "accept")
	if r.breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s accept\n", r.breakGlass, r.proto, r.portExpr)
		return
	}
	fmt.Fprintf(b, "        %s dport %s ip saddr != @%s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", r.proto, r.portExpr, r.geo.setName)
}

func writePolicyGeoBlockDropLogged(b *strings.Builder, geoSet, breakGlass, proto, portExpr string) {
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", geoSet, breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", geoSet, proto, portExpr)
}
