package gen

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

const (
	setBreakGlass  = "break_glass_v4"
	setGlobalDeny  = "global_src_deny_v4"
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
	set := c.Geo.SetName
	if set == "" {
		set = "geo_v4"
	}
	block := strings.EqualFold(strings.TrimSpace(c.Geo.Mode), "block")
	return routeGeoParams{enabled: true, blockListed: block, setName: set}, nil
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

func writeRouteCustomGeoSets(b *strings.Builder, c *config.Config) error {
	if !c.Geo.Enabled || c.Geo.ZoneDir == "" {
		return nil
	}
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		if strings.ToLower(strings.TrimSpace(r.GeoMode)) != config.RouteGeoCustom {
			continue
		}
		elems, err := ZoneCIDRsForCountries(c.Geo.ZoneDir, r.GeoCountries)
		if err != nil {
			return fmt.Errorf("forwarding.routes[%d] geo_countries: %w", i, err)
		}
		if len(elems) == 0 {
			return fmt.Errorf("forwarding.routes[%d]: no CIDRs loaded for custom geo", i)
		}
		writeRouteSrcSet(b, routeGeoSetName(i), elems)
	}
	return nil
}

func writePolicyDnatLine(b *strings.Builder, gp routeGeoParams, proto, publicDport, dnatTo, srcAllow, srcDeny, breakGlass, globalDeny string) {
	if publicDport == "" || dnatTo == "" {
		return
	}
	if globalDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", globalDeny, proto, publicDport)
	}
	if srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", srcDeny, proto, publicDport)
	}
	if !gp.enabled {
		writePolicyDnatAllow(b, proto, publicDport, dnatTo, srcAllow)
		return
	}
	if gp.blockListed {
		writePolicyGeoBlockDrop(b, gp.setName, breakGlass, proto, publicDport)
		writePolicyDnatAllow(b, proto, publicDport, dnatTo, srcAllow)
		return
	}
	writePolicyDnatAllow(b, proto, publicDport, dnatTo, srcAllow, gp.setName)
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s dnat to %s\n", breakGlass, proto, publicDport, dnatTo)
	}
}

func writePolicyDnatAllow(b *strings.Builder, proto, publicDport, dnatTo, srcAllow string, geoSet ...string) {
	if len(geoSet) > 0 && geoSet[0] != "" {
		if srcAllow != "" {
			fmt.Fprintf(b, "        ip saddr @%s ip saddr @%s %s dport %s dnat to %s\n", srcAllow, geoSet[0], proto, publicDport, dnatTo)
			return
		}
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s dnat to %s\n", geoSet[0], proto, publicDport, dnatTo)
		return
	}
	if srcAllow != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s dnat to %s\n", srcAllow, proto, publicDport, dnatTo)
		return
	}
	fmt.Fprintf(b, "        %s dport %s dnat to %s\n", proto, publicDport, dnatTo)
}

func writePolicyGeoBlockDrop(b *strings.Builder, geoSet, breakGlass, proto, portExpr string) {
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s drop\n", geoSet, breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", geoSet, proto, portExpr)
}

func writePolicyInputPort(b *strings.Builder, gp routeGeoParams, routeIndex int, globalRL, routeRL config.RateLimit, proto, portExpr, srcAllow, srcDeny, crowdsecSet, breakGlass, globalDeny string) {
	if portExpr == "" {
		return
	}
	if globalDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", globalDeny, proto, portExpr)
	}
	if srcDeny != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s drop\n", srcDeny, proto, portExpr)
	}
	writePolicyCrowdsecDrop(b, crowdsecSet, breakGlass, proto, portExpr)
	writePolicyRateLimit(b, routeIndex, globalRL, routeRL, proto, portExpr, breakGlass)
	if !gp.enabled {
		writePolicyInputAllow(b, proto, portExpr, srcAllow)
		return
	}
	if gp.blockListed {
		writePolicyGeoBlockDropLogged(b, gp.setName, breakGlass, proto, portExpr)
		writePolicyInputAllow(b, proto, portExpr, srcAllow)
		return
	}
	writePolicyInputAllow(b, proto, portExpr, srcAllow, gp.setName)
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s accept\n", breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        %s dport %s ip saddr != @%s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", proto, portExpr, gp.setName)
}

func writePolicyInputAllow(b *strings.Builder, proto, portExpr, srcAllow string, geoSet ...string) {
	if len(geoSet) > 0 && geoSet[0] != "" {
		if srcAllow != "" {
			fmt.Fprintf(b, "        ip saddr @%s ip saddr @%s %s dport %s accept\n", srcAllow, geoSet[0], proto, portExpr)
			return
		}
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s accept\n", geoSet[0], proto, portExpr)
		return
	}
	if srcAllow != "" {
		fmt.Fprintf(b, "        ip saddr @%s %s dport %s accept\n", srcAllow, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        %s dport %s accept\n", proto, portExpr)
}

func writePolicyGeoBlockDropLogged(b *strings.Builder, geoSet, breakGlass, proto, portExpr string) {
	if breakGlass != "" {
		fmt.Fprintf(b, "        ip saddr @%s ip saddr != @%s %s dport %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", geoSet, breakGlass, proto, portExpr)
		return
	}
	fmt.Fprintf(b, "        ip saddr @%s %s dport %s limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop\n", geoSet, proto, portExpr)
}
