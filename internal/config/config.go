package config

import (
	"fmt"
	"net"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WireGuard   WireGuard   `yaml:"wireguard"`
	Network     Network     `yaml:"network"`
	Forwarding  Forwarding  `yaml:"forwarding"`
	Geo         Geo         `yaml:"geo"`
	InputAllows []AllowRule `yaml:"input_allows"`
	Peers       []Peer      `yaml:"peers"`
}

type WireGuard struct {
	Interface      string `yaml:"interface"`
	ListenPort     int    `yaml:"listen_port"`
	PrivateKeyFile string `yaml:"private_key_file"`
	Address        string `yaml:"address"` // e.g. 10.100.0.1/24
}

type Network struct {
	PublicInterface string `yaml:"public_interface"`
}

type Forwarding struct {
	TCPPorts []string `yaml:"tcp_ports"`
	UDPPorts []string `yaml:"udp_ports"`
	TargetIP string   `yaml:"target_ip"` // peer tunnel IP for DNAT (no CIDR)
}

type Geo struct {
	Enabled   bool     `yaml:"enabled"`
	SetName   string   `yaml:"set_name"`
	Countries []string `yaml:"countries"`
	ZoneDir   string   `yaml:"zone_dir"`
}

type AllowRule struct {
	Proto string `yaml:"proto"`
	DPort string `yaml:"dport"` // single port, range, or brace list e.g. "{80,443}"
	Note  string `yaml:"note,omitempty"`
}

type Peer struct {
	Name      string `yaml:"name"`
	PublicKey string `yaml:"public_key"`
	TunnelIP  string `yaml:"tunnel_ip"` // e.g. 10.100.0.2/32
	Disabled  bool   `yaml:"disabled,omitempty"`
}

func Load(path string) (*Config, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var c Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return nil, err
	}
	if err := c.Validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) Validate() error {
	if c.WireGuard.Interface == "" {
		return fmt.Errorf("wireguard.interface is required")
	}
	if c.WireGuard.ListenPort <= 0 || c.WireGuard.ListenPort > 65535 {
		return fmt.Errorf("wireguard.listen_port must be between 1 and 65535")
	}
	if c.WireGuard.PrivateKeyFile == "" {
		return fmt.Errorf("wireguard.private_key_file is required")
	}
	if c.WireGuard.Address == "" {
		return fmt.Errorf("wireguard.address is required")
	}
	if c.Network.PublicInterface == "" {
		return fmt.Errorf("network.public_interface is required")
	}
	if c.Forwarding.TargetIP == "" {
		return fmt.Errorf("forwarding.target_ip is required")
	}
	if len(c.Forwarding.TCPPorts) == 0 && len(c.Forwarding.UDPPorts) == 0 {
		return fmt.Errorf("forwarding: at least one of tcp_ports or udp_ports is required")
	}
	if net.ParseIP(c.Forwarding.TargetIP) == nil {
		return fmt.Errorf("forwarding.target_ip must be a valid IPv4 address")
	}
	if c.Geo.Enabled {
		if c.Geo.SetName == "" {
			c.Geo.SetName = "geo_v4"
		}
		if len(c.Geo.Countries) == 0 {
			return fmt.Errorf("geo.countries required when geo.enabled")
		}
		if c.Geo.ZoneDir == "" {
			return fmt.Errorf("geo.zone_dir required when geo.enabled")
		}
	}
	for _, p := range c.Peers {
		if p.Disabled {
			continue
		}
		if p.Name == "" || p.PublicKey == "" || p.TunnelIP == "" {
			return fmt.Errorf("peer %q: name, public_key, and tunnel_ip are required", p.Name)
		}
		tip := strings.TrimSpace(p.TunnelIP)
		if _, _, err := net.ParseCIDR(tip); err != nil {
			if net.ParseIP(tip) == nil {
				return fmt.Errorf("peer %s: invalid tunnel_ip", p.Name)
			}
		}
	}
	return nil
}
