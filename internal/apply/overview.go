package apply

import (
	"github.com/imevul/evuproxy/internal/config"
)

// Overview is a non-secret summary of the loaded config for the API/UI.
type Overview struct {
	Interface       string   `json:"wireguard_interface"`
	ListenPort      int      `json:"wireguard_listen_port"`
	PublicInterface string   `json:"public_interface"`
	TargetIP        string   `json:"forwarding_target_ip"`
	TCPPorts        []string `json:"tcp_ports"`
	UDPPorts        []string `json:"udp_ports"`
	GeoEnabled      bool     `json:"geo_enabled"`
	GeoCountries    []string `json:"geo_countries,omitempty"`
	PeerNames       []string `json:"peer_names"`
}

func OverviewFromConfig(path string) (*Overview, error) {
	c, err := config.Load(path)
	if err != nil {
		return nil, err
	}
	o := &Overview{
		Interface:       c.WireGuard.Interface,
		ListenPort:      c.WireGuard.ListenPort,
		PublicInterface: c.Network.PublicInterface,
		TargetIP:        c.Forwarding.TargetIP,
		TCPPorts:        c.Forwarding.TCPPorts,
		UDPPorts:        c.Forwarding.UDPPorts,
		GeoEnabled:      c.Geo.Enabled,
		GeoCountries:    append([]string(nil), c.Geo.Countries...),
	}
	for _, p := range c.Peers {
		if !p.Disabled {
			o.PeerNames = append(o.PeerNames, p.Name)
		}
	}
	return o, nil
}
