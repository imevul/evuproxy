package apply

import (
	"net"
	"os"
	"os/exec"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// Overview is a non-secret summary of the loaded config for the API/UI.
type Overview struct {
	Interface        string                `json:"wireguard_interface"`
	ListenPort       int                   `json:"wireguard_listen_port"`
	PublicInterface  string                `json:"public_interface"`
	ForwardingRoutes []config.ForwardRoute `json:"forwarding_routes"`
	GeoEnabled       bool                  `json:"geo_enabled"`
	GeoCountries     []string              `json:"geo_countries,omitempty"`
	PeerNames        []string              `json:"peer_names"`
	// ServerPublicKey is derived with `wg pubkey` from wireguard.private_key_file (empty if unavailable).
	ServerPublicKey string `json:"server_public_key,omitempty"`
	// TunnelSubnet is the CIDR of the WireGuard interface address (for client AllowedIPs).
	TunnelSubnet string `json:"tunnel_subnet,omitempty"`
}

func OverviewFromConfig(path string) (*Overview, error) {
	c, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	o := &Overview{
		Interface:        c.WireGuard.Interface,
		ListenPort:       c.WireGuard.ListenPort,
		PublicInterface:  c.Network.PublicInterface,
		ForwardingRoutes: append([]config.ForwardRoute(nil), c.Forwarding.Routes...),
		GeoEnabled:       c.Geo.Enabled,
		GeoCountries:     append([]string(nil), c.Geo.Countries...),
	}
	for _, p := range c.Peers {
		if !p.Disabled {
			o.PeerNames = append(o.PeerNames, p.Name)
		}
	}
	if _, ipNet, err := net.ParseCIDR(strings.TrimSpace(c.WireGuard.Address)); err == nil && ipNet != nil {
		o.TunnelSubnet = ipNet.String()
	}
	o.ServerPublicKey = wgPublicKeyFromFile(c.WireGuard.PrivateKeyFile)
	return o, nil
}

func wgPublicKeyFromFile(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	cmd := exec.Command("wg", "pubkey")
	cmd.Stdin = strings.NewReader(strings.TrimSpace(string(b)) + "\n")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
