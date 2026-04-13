package config

import (
	"fmt"
	"strconv"
	"strings"
)

// maxExpandedPortsPerRoute limits DoS via huge port ranges in config validation.
const maxExpandedPortsPerRoute = 4096

// ExpandRoutePortNumbers expands forwarding route port entries into distinct UDP/TCP port numbers
// using the same shapes as nftables formatPortSets: single ports, ranges, and brace lists.
func ExpandRoutePortNumbers(ports []string) ([]uint16, error) {
	seen := map[uint16]struct{}{}
	for _, raw := range ports {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if strings.HasPrefix(raw, "{") && strings.HasSuffix(raw, "}") {
			inner := strings.TrimSpace(raw[1 : len(raw)-1])
			for _, tok := range strings.Split(inner, ",") {
				tok = strings.TrimSpace(tok)
				if tok == "" {
					continue
				}
				ps, err := expandPortToken(tok)
				if err != nil {
					return nil, err
				}
				for _, p := range ps {
					seen[p] = struct{}{}
					if len(seen) > maxExpandedPortsPerRoute {
						return nil, fmt.Errorf("too many distinct ports (max %d per route)", maxExpandedPortsPerRoute)
					}
				}
			}
			continue
		}
		ps, err := expandPortToken(raw)
		if err != nil {
			return nil, err
		}
		for _, p := range ps {
			seen[p] = struct{}{}
			if len(seen) > maxExpandedPortsPerRoute {
				return nil, fmt.Errorf("too many distinct ports (max %d per route)", maxExpandedPortsPerRoute)
			}
		}
	}
	out := make([]uint16, 0, len(seen))
	for p := range seen {
		out = append(out, p)
	}
	// Deterministic order for stable errors
	for i := 0; i < len(out); i++ {
		for j := i + 1; j < len(out); j++ {
			if out[j] < out[i] {
				out[i], out[j] = out[j], out[i]
			}
		}
	}
	return out, nil
}

func expandPortToken(tok string) ([]uint16, error) {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return nil, fmt.Errorf("empty port token")
	}
	if strings.Contains(tok, "-") {
		parts := strings.SplitN(tok, "-", 2)
		a, err := strconv.Atoi(strings.TrimSpace(parts[0]))
		if err != nil {
			return nil, fmt.Errorf("invalid port range %q", tok)
		}
		b, err := strconv.Atoi(strings.TrimSpace(parts[1]))
		if err != nil {
			return nil, fmt.Errorf("invalid port range %q", tok)
		}
		if a < 1 || b < 1 || a > 65535 || b > 65535 || a > b {
			return nil, fmt.Errorf("invalid port range %q", tok)
		}
		if b-a+1 > maxExpandedPortsPerRoute {
			return nil, fmt.Errorf("port range too large in %q (max %d ports)", tok, maxExpandedPortsPerRoute)
		}
		var out []uint16
		for p := a; p <= b; p++ {
			out = append(out, uint16(p))
		}
		return out, nil
	}
	p, err := strconv.Atoi(tok)
	if err != nil {
		return nil, fmt.Errorf("invalid port %q", tok)
	}
	if p < 1 || p > 65535 {
		return nil, fmt.Errorf("port out of range: %d", p)
	}
	return []uint16{uint16(p)}, nil
}
