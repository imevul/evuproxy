package gen

import (
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestNFTablesRoutesGeo(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
				{Proto: "udp", Ports: []string{"19132-19133"}, TargetIP: "10.100.0.3"},
			},
		},
		Geo: config.Geo{Enabled: true, SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"},
		Peers: []config.Peer{
			{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"},
			{Name: "b", PublicKey: "y", TunnelIP: "10.100.0.3/32"},
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "dnat to 10.100.0.2") || !strings.Contains(s, "dnat to 10.100.0.3") {
		t.Fatalf("missing dnat: %s", s)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport") {
		t.Fatal("expected geo-wrapped tcp input")
	}
	if strings.Contains(s, "ip saddr @geo_v4 tcp dport { 25565 } limit rate") {
		t.Fatal("did not expect block-style geo on allow mode")
	}
	if !strings.Contains(s, "ip daddr 10.100.0.2 tcp dport") {
		t.Fatal("expected forward tcp rule")
	}
	if !strings.Contains(s, "ip daddr 10.100.0.3 masquerade") {
		t.Fatal("expected masquerade for second target")
	}
}

func TestNFTablesRoutesGeoBlockMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo: config.Geo{Enabled: true, Mode: "block", SetName: "geo_v4", Countries: []string{"ru"}, ZoneDir: "/z"},
		Peers: []config.Peer{
			{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"},
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport { 25565 } drop") {
		t.Fatalf("expected block-first geo drop before dnat: %s", s)
	}
	if !strings.Contains(s, "tcp dport { 25565 } dnat to 10.100.0.2") {
		t.Fatal("expected dnat after block rule")
	}
}

func TestNFTablesAdminTCPPortsDisabled(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0", AdminTCPPorts: []int{}},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "tcp dport 9080 accept") {
		t.Fatalf("expected no default admin port when admin_tcp_ports is empty: %s", s)
	}
}

func TestNFTablesRoutesBothProtosOneRoute(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp,udp", Ports: []string{"19132"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport { 19132 } dnat to 10.100.0.2") {
		t.Fatalf("missing tcp dnat: %s", s)
	}
	if !strings.Contains(s, "udp dport { 19132 } dnat to 10.100.0.2") {
		t.Fatalf("missing udp dnat: %s", s)
	}
}

func TestNFTablesSkipsDisabledRoute(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
				{Proto: "tcp", Ports: []string{"9999"}, TargetIP: "10.100.0.2", Disabled: true},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "9999") {
		t.Fatalf("disabled route must not appear in nftables: %s", s)
	}
	if !strings.Contains(s, "tcp dport { 80 }") {
		t.Fatalf("enabled route must appear: %s", s)
	}
}

func TestNFTablesSkipsDisabledInputAllow(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "22"},
			{Proto: "tcp", DPort: "9999", Disabled: true},
		},
		Geo: config.Geo{Enabled: false},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 22 accept") {
		t.Fatalf("enabled input_allow must appear: %s", s)
	}
	if strings.Contains(s, "tcp dport 9999 accept") {
		t.Fatalf("disabled input_allow must not appear in nftables: %s", s)
	}
}

func TestNFTablesInputAllowsUnfilteredWhenGeoApplyOff(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{Enabled: true, SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 2222 accept") {
		t.Fatalf("input_allow must be plain accept when apply_to_input_allows is false: %s", s)
	}
	if strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222") {
		t.Fatalf("did not expect geo on input_allow 2222: %s", s)
	}
}

func TestNFTablesInputAllowsGeoAllowMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{
			Enabled:            true,
			SetName:            "geo_v4",
			Countries:          []string{"no"},
			ZoneDir:            "/z",
			ApplyToInputAllows: true,
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222 accept") {
		t.Fatalf("expected geo allow on input 2222: %s", s)
	}
	if !strings.Contains(s, "tcp dport 2222 ip saddr != @geo_v4") {
		t.Fatalf("expected geo drop for non-set on input 2222: %s", s)
	}
}

func TestNFTablesInputAllowsGeoBlockMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{
			Enabled:            true,
			Mode:               "block",
			SetName:            "geo_v4",
			Countries:          []string{"ru"},
			ZoneDir:            "/z",
			ApplyToInputAllows: true,
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222 limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop") {
		t.Fatalf("expected block-list geo drop on input 2222: %s", s)
	}
	if !strings.Contains(s, "tcp dport 2222 accept") {
		t.Fatalf("expected accept after block rule for input 2222: %s", s)
	}
}

func TestNFTablesForwardAllowDockerBridges(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{
			PublicInterface:           "eth0",
			ForwardAllowDockerBridges: true,
			ForwardExtraLocalCIDRs:    []string{"10.89.0.0/24"},
		},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 172.16.0.0/12 accept") {
		t.Fatalf("expected docker bridge ingress allow: %s", s)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 192.168.0.0/16 accept") {
		t.Fatalf("expected 192.168 ingress allow: %s", s)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 10.89.0.0/24 accept") {
		t.Fatalf("expected extra CIDR ingress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 172.16.0.0/12 oifname \"eth0\" accept") {
		t.Fatalf("expected docker bridge egress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 192.168.0.0/16 oifname \"eth0\" accept") {
		t.Fatalf("expected 192.168 egress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 10.89.0.0/24 oifname \"eth0\" accept") {
		t.Fatalf("expected extra CIDR egress allow: %s", s)
	}
}

func TestNFTablesAdminTCPPortsExplicit(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0", AdminTCPPorts: []int{8443}},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 8443 accept") {
		t.Fatalf("expected explicit admin_tcp_ports on INPUT: %s", s)
	}
}
