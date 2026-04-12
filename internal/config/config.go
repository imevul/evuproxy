package config

import (
	"fmt"
	"net"
	"os"
	"sort"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

type Config struct {
	WireGuard   WireGuard   `yaml:"wireguard" json:"wireguard"`
	Network     Network     `yaml:"network" json:"network"`
	Forwarding  Forwarding  `yaml:"forwarding" json:"forwarding"`
	Geo         Geo         `yaml:"geo" json:"geo"`
	InputAllows []AllowRule `yaml:"input_allows" json:"input_allows"`
	Peers       []Peer      `yaml:"peers" json:"peers"`
}

type WireGuard struct {
	Interface      string `yaml:"interface" json:"interface"`
	ListenPort     int    `yaml:"listen_port" json:"listen_port"`
	PrivateKeyFile string `yaml:"private_key_file" json:"private_key_file"`
	Address        string `yaml:"address" json:"address"` // e.g. 10.100.0.1/24
}

type Network struct {
	PublicInterface string `yaml:"public_interface" json:"public_interface"`
	// AdminTCPPorts are optional extra INPUT allows for host services (TCP only).
	// Omitted or [] adds none; use input_allows for typical SSH / HTTP / admin UI rules.
	AdminTCPPorts []int `yaml:"admin_tcp_ports,omitempty" json:"admin_tcp_ports,omitempty"`
}

type Forwarding struct {
	Routes []ForwardRoute `yaml:"routes" json:"routes"`
}

// ForwardRoute maps public TCP or UDP ports to a peer tunnel IPv4 (must match a peer's tunnel_ip).
type ForwardRoute struct {
	Proto    string   `yaml:"proto" json:"proto"`         // tcp, udp, both, or comma/plus-separated e.g. tcp,udp
	Ports    []string `yaml:"ports" json:"ports"`         // port/range/brace-list strings (nft dport set syntax)
	TargetIP string   `yaml:"target_ip" json:"target_ip"` // IPv4, no CIDR
}

type Geo struct {
	Enabled   bool     `yaml:"enabled" json:"enabled"`
	Mode      string   `yaml:"mode,omitempty" json:"mode,omitempty"` // allow (default) or block — listed countries are allowed or blocked
	SetName   string   `yaml:"set_name" json:"set_name"`
	Countries []string `yaml:"countries" json:"countries"`
	ZoneDir   string   `yaml:"zone_dir" json:"zone_dir"`
}

type AllowRule struct {
	Proto string `yaml:"proto" json:"proto"`
	DPort string `yaml:"dport" json:"dport"` // single port, range, or brace list e.g. "{80,443}"
	Note  string `yaml:"note,omitempty" json:"note,omitempty"`
}

type Peer struct {
	Name      string `yaml:"name" json:"name"`
	PublicKey string `yaml:"public_key" json:"public_key"`
	TunnelIP  string `yaml:"tunnel_ip" json:"tunnel_ip"` // e.g. 10.100.0.2/32
	Disabled  bool   `yaml:"disabled,omitempty" json:"disabled,omitempty"`
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

// PeerTunnelIPv4 returns the IPv4 address string for a peer tunnel_ip value, or "" if invalid.
func PeerTunnelIPv4(tunnelIP string) string {
	s := strings.TrimSpace(tunnelIP)
	if s == "" {
		return ""
	}
	if ip, _, err := net.ParseCIDR(s); err == nil && ip != nil {
		ip4 := ip.To4()
		if ip4 == nil {
			return ""
		}
		return ip4.String()
	}
	ip := net.ParseIP(s)
	if ip == nil {
		return ""
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return ""
	}
	return ip4.String()
}

// ParseRouteProtocols parses forwarding.routes proto values into distinct "tcp" and/or "udp".
// Accepts a single protocol, "both", or multiple tokens separated by comma, plus, or Unicode spaces.
func ParseRouteProtocols(s string) ([]string, error) {
	s = strings.ToLower(strings.TrimSpace(s))
	if s == "" {
		return nil, fmt.Errorf("proto is required")
	}
	if s == "both" {
		return []string{"tcp", "udp"}, nil
	}
	parts := strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == '+' || unicode.IsSpace(r)
	})
	seen := map[string]struct{}{}
	var out []string
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if p != "tcp" && p != "udp" {
			return nil, fmt.Errorf("invalid proto %q (want tcp, udp, or both)", p)
		}
		if _, ok := seen[p]; !ok {
			seen[p] = struct{}{}
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return nil, fmt.Errorf("proto is required")
	}
	sort.Strings(out)
	return out, nil
}

func (c *Config) Validate() error {
	if c.WireGuard.Interface == "" {
		return fmt.Errorf("wireguard.interface is required")
	}
	if err := validLinuxIface(c.WireGuard.Interface); err != nil {
		return fmt.Errorf("wireguard.interface: %w", err)
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
	if err := validLinuxIface(c.Network.PublicInterface); err != nil {
		return fmt.Errorf("network.public_interface: %w", err)
	}
	for i, a := range c.InputAllows {
		if err := ValidateInputAllowDport(a.DPort); err != nil {
			return fmt.Errorf("input_allows[%d].dport: %w", i, err)
		}
	}
	if c.Network.AdminTCPPorts != nil {
		for _, p := range c.Network.AdminTCPPorts {
			if p <= 0 || p > 65535 {
				return fmt.Errorf("network.admin_tcp_ports: invalid port %d", p)
			}
		}
	}
	if err := c.validateForwardingRoutes(); err != nil {
		return err
	}
	if c.Geo.Enabled {
		if c.Geo.SetName == "" {
			c.Geo.SetName = "geo_v4"
		}
		mode := strings.ToLower(strings.TrimSpace(c.Geo.Mode))
		if mode == "" {
			mode = "allow"
		}
		if mode != "allow" && mode != "block" {
			return fmt.Errorf("geo.mode must be allow or block")
		}
		c.Geo.Mode = mode
		if len(c.Geo.Countries) == 0 {
			return fmt.Errorf("geo.countries required when geo.enabled")
		}
		if c.Geo.ZoneDir == "" {
			return fmt.Errorf("geo.zone_dir required when geo.enabled")
		}
		if err := validNFTSetName(c.Geo.SetName); err != nil {
			return fmt.Errorf("geo.set_name: %w", err)
		}
		for _, cc := range c.Geo.Countries {
			if err := validateGeoCountryCode(cc); err != nil {
				return err
			}
		}
	}
	for _, p := range c.Peers {
		if p.Disabled {
			continue
		}
		if p.Name == "" || p.PublicKey == "" || p.TunnelIP == "" {
			return fmt.Errorf("peer %q: name, public_key, and tunnel_ip are required", p.Name)
		}
		if err := validPeerName(p.Name); err != nil {
			return fmt.Errorf("peer %q: %w", p.Name, err)
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

func (c *Config) validateForwardingRoutes() error {
	allowed := map[string]struct{}{}
	for _, p := range c.Peers {
		if p.Disabled {
			continue
		}
		ip := PeerTunnelIPv4(p.TunnelIP)
		if ip != "" {
			allowed[ip] = struct{}{}
		}
	}
	for i, r := range c.Forwarding.Routes {
		if _, err := ParseRouteProtocols(r.Proto); err != nil {
			return fmt.Errorf("forwarding.routes[%d]: %w", i, err)
		}
		if len(r.Ports) == 0 {
			return fmt.Errorf("forwarding.routes[%d]: ports is required", i)
		}
		hasPort := false
		for _, port := range r.Ports {
			if strings.TrimSpace(port) != "" {
				hasPort = true
				break
			}
		}
		if !hasPort {
			return fmt.Errorf("forwarding.routes[%d]: at least one non-empty port entry is required", i)
		}
		tip := strings.TrimSpace(r.TargetIP)
		if net.ParseIP(tip) == nil {
			return fmt.Errorf("forwarding.routes[%d]: target_ip must be a valid IPv4 address", i)
		}
		if _, ok := allowed[tip]; !ok {
			return fmt.Errorf("forwarding.routes[%d]: target_ip %s must match a non-disabled peer tunnel_ip", i, tip)
		}
	}
	return nil
}
