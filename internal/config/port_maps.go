package config

import (
	"fmt"
	"strings"
)

// PortMap maps a public destination port expression to an internal DNAT port on the peer.
type PortMap struct {
	Public   string `yaml:"public" json:"public"`
	Internal string `yaml:"internal" json:"internal"`
}

// RouteGeoMode controls per-route geoblocking (forward path only).
const (
	RouteGeoInherit = "inherit"
	RouteGeoOff     = "off"
	RouteGeoCustom  = "custom"
)

// ValidatePortMaps checks port_maps against forwarding.routes[i].ports.
func ValidatePortMaps(routeIndex int, ports []string, maps []PortMap) error {
	if len(maps) == 0 {
		return nil
	}
	if len(maps) > MaxPortMapsPerRoute {
		return &ValidationError{
			Code: "port_map_invalid",
			Msg:  fmt.Sprintf("forwarding.routes[%d]: at most %d port_maps entries", routeIndex, MaxPortMapsPerRoute),
		}
	}
	byPublic := map[string]int{}
	for j, m := range maps {
		pub := strings.TrimSpace(m.Public)
		intn := strings.TrimSpace(m.Internal)
		if pub == "" || intn == "" {
			return &ValidationError{
				Code: "port_map_invalid",
				Msg:  fmt.Sprintf("forwarding.routes[%d].port_maps[%d]: public and internal are required", routeIndex, j),
			}
		}
		if err := validatePortMapPair(pub, intn); err != nil {
			return &ValidationError{
				Code: "port_map_invalid",
				Msg:  fmt.Sprintf("forwarding.routes[%d].port_maps[%d]: %v", routeIndex, j, err),
			}
		}
		if prev, ok := byPublic[pub]; ok {
			return &ValidationError{
				Code: "port_map_invalid",
				Msg:  fmt.Sprintf("forwarding.routes[%d].port_maps[%d]: duplicate public %q (also at [%d])", routeIndex, j, pub, prev),
			}
		}
		byPublic[pub] = j
	}
	// Each ports[] token must exist in ports list; map rows must reference tokens present in ports[].
	portTokens := normalizedPortTokens(ports)
	if len(portTokens) == 0 {
		return &ValidationError{
			Code: "port_map_invalid",
			Msg:  fmt.Sprintf("forwarding.routes[%d]: port_maps set but ports is empty", routeIndex),
		}
	}
	tokenSet := map[string]struct{}{}
	for _, t := range portTokens {
		tokenSet[t] = struct{}{}
	}
	for pub := range byPublic {
		if _, ok := tokenSet[pub]; !ok {
			return &ValidationError{
				Code: "port_map_invalid",
				Msg:  fmt.Sprintf("forwarding.routes[%d].port_maps: public %q is not a ports[] entry on this route", routeIndex, pub),
			}
		}
	}
	return nil
}

// MaxPortMapsPerRoute caps explicit port map rows per route.
const MaxPortMapsPerRoute = 64

func normalizedPortTokens(ports []string) []string {
	var out []string
	for _, raw := range ports {
		raw = strings.TrimSpace(raw)
		if raw != "" {
			out = append(out, raw)
		}
	}
	return out
}

func validatePortMapPair(public, internal string) error {
	if strings.ContainsAny(public, "\n\r") || strings.ContainsAny(internal, "\n\r") {
		return fmt.Errorf("port expressions cannot contain newlines")
	}
	// Range: require equal span.
	if strings.Contains(public, "-") && !strings.Contains(public, "{") {
		if !strings.Contains(internal, "-") || strings.Contains(internal, "{") {
			return fmt.Errorf("internal must be a parallel range when public is a range")
		}
		pubPorts, err := expandPortToken(public)
		if err != nil {
			return err
		}
		intPorts, err := expandPortToken(internal)
		if err != nil {
			return err
		}
		if len(pubPorts) != len(intPorts) {
			return fmt.Errorf("public range width %d does not match internal width %d", len(pubPorts), len(intPorts))
		}
		return nil
	}
	if strings.Contains(internal, "-") && !strings.Contains(internal, "{") {
		return fmt.Errorf("internal range requires public range with the same width")
	}
	// Brace or single port: validate tokens parse.
	if strings.HasPrefix(strings.TrimSpace(public), "{") {
		if err := validateBraceDport(public); err != nil {
			return err
		}
	} else if err := validatePlainDportToken(public); err != nil {
		return err
	}
	if strings.HasPrefix(strings.TrimSpace(internal), "{") {
		return fmt.Errorf("brace internal port mapping is not supported; use discrete ports or ranges")
	}
	if err := validatePlainDportToken(internal); err != nil {
		return err
	}
	return nil
}

// ExpandRoutePublicPortNumbers returns public-side port numbers for overlap checks.
// Uses port_maps public expressions when set; unmapped ports[] tokens expand as 1:1 public ports.
func ExpandRoutePublicPortNumbers(r ForwardRoute) ([]uint16, error) {
	if len(r.PortMaps) == 0 {
		return ExpandRoutePortNumbers(r.Ports)
	}
	mapped := map[string]struct{}{}
	for _, m := range r.PortMaps {
		mapped[strings.TrimSpace(m.Public)] = struct{}{}
	}
	seen := map[uint16]struct{}{}
	addPorts := func(ps []uint16) error {
		for _, p := range ps {
			seen[p] = struct{}{}
			if len(seen) > maxDistinctPortsPerRoute {
				return fmt.Errorf("too many distinct public ports (max %d per route)", maxDistinctPortsPerRoute)
			}
		}
		return nil
	}
	for _, m := range r.PortMaps {
		ps, err := expandPortToken(strings.TrimSpace(m.Public))
		if err != nil {
			return nil, fmt.Errorf("port_maps public %q: %w", m.Public, err)
		}
		if err := addPorts(ps); err != nil {
			return nil, err
		}
	}
	for _, tok := range normalizedPortTokens(r.Ports) {
		if _, ok := mapped[tok]; ok {
			continue
		}
		ps, err := expandPortToken(tok)
		if err != nil {
			return nil, fmt.Errorf("ports %q: %w", tok, err)
		}
		if err := addPorts(ps); err != nil {
			return nil, err
		}
	}
	out := make([]uint16, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	sortPortSlice(out)
	return out, nil
}

func sortPortSlice(out []uint16) {
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
}

// DNATDestination returns the nft dnat target for a public port token (host or host:port).
func DNATDestination(targetIP, publicToken string, maps []PortMap) (string, error) {
	targetIP = strings.TrimSpace(targetIP)
	if len(maps) == 0 {
		return targetIP, nil
	}
	for _, m := range maps {
		if strings.TrimSpace(m.Public) != strings.TrimSpace(publicToken) {
			continue
		}
		intn := strings.TrimSpace(m.Internal)
		if strings.Contains(intn, "-") && !strings.Contains(intn, "{") {
			// Parallel range: dnat to ip:low-high
			parts := strings.SplitN(intn, "-", 2)
			lo := strings.TrimSpace(parts[0])
			hi := strings.TrimSpace(parts[1])
			return fmt.Sprintf("%s:%s-%s", targetIP, lo, hi), nil
		}
		if strings.HasPrefix(intn, "{") {
			return "", fmt.Errorf("brace internal port mapping is not supported in DNAT; use discrete ports or ranges")
		}
		return fmt.Sprintf("%s:%s", targetIP, intn), nil
	}
	// Implicit 1:1 — destination is host only (same port).
	return targetIP, nil
}
