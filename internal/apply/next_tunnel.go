package apply

import (
	"encoding/binary"
	"fmt"
	"net"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// NextFreeTunnelIP picks an unused IPv4 in the UI peer tunnel subnet (host part) for a new peer.
// Uses /32 for the returned value. Returns an error if no address is free.
func NextFreeTunnelIP(cfgPath string, c *config.Config) (string, error) {
	prefs, err := LoadUIPreferences(cfgPath)
	if err != nil {
		return "", err
	}
	_, ipnet, err := net.ParseCIDR(strings.TrimSpace(prefs.PeerTunnelSubnetCIDR))
	if err != nil {
		return "", fmt.Errorf("peer tunnel subnet: %w", err)
	}
	ip4 := ipnet.IP.To4()
	if ip4 == nil {
		return "", fmt.Errorf("peer tunnel subnet must be IPv4")
	}
	mask := net.IP(ipnet.Mask).To4()
	if mask == nil {
		return "", fmt.Errorf("invalid mask")
	}
	netU := binary.BigEndian.Uint32(ip4) & binary.BigEndian.Uint32(mask)
	bcastU := netU | ^binary.BigEndian.Uint32(mask)

	used := map[uint32]struct{}{}
	if _, n, err := net.ParseCIDR(strings.TrimSpace(c.WireGuard.Address)); err == nil && n != nil {
		if s := n.IP.To4(); s != nil {
			used[binary.BigEndian.Uint32(s)] = struct{}{}
		}
	}
	for _, p := range c.Peers {
		if p.Disabled {
			continue
		}
		tip := config.PeerTunnelIPv4(p.TunnelIP)
		if tip == "" {
			continue
		}
		ip := net.ParseIP(tip).To4()
		if ip == nil {
			continue
		}
		used[binary.BigEndian.Uint32(ip)] = struct{}{}
	}

	for host := netU + 1; host < bcastU; host++ {
		if _, ok := used[host]; ok {
			continue
		}
		out := make(net.IP, 4)
		binary.BigEndian.PutUint32(out, host)
		return out.String() + "/32", nil
	}
	return "", fmt.Errorf("no free tunnel IP in %s", prefs.PeerTunnelSubnetCIDR)
}
