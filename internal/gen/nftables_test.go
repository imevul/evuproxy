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
	if !strings.Contains(s, "ip daddr 10.100.0.2 tcp dport") {
		t.Fatal("expected forward tcp rule")
	}
	if !strings.Contains(s, "ip daddr 10.100.0.3 masquerade") {
		t.Fatal("expected masquerade for second target")
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
