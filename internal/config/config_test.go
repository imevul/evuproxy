package config

import (
	"testing"
)

func TestValidateAllowsEmptyForwardingRoutes(t *testing.T) {
	c := sampleBase()
	c.Forwarding = Forwarding{Routes: nil}
	c.Peers = []Peer{{Name: "a", PublicKey: "k", TunnelIP: "10.100.0.2/32"}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.Forwarding = Forwarding{Routes: []ForwardRoute{}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRoutesMode(t *testing.T) {
	c := sampleBase()
	c.Forwarding = Forwarding{
		Routes: []ForwardRoute{
			{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
			{Proto: "udp", Ports: []string{"19132"}, TargetIP: "10.100.0.3"},
		},
	}
	c.Peers = []Peer{
		{Name: "a", PublicKey: "k1", TunnelIP: "10.100.0.2/32"},
		{Name: "b", PublicKey: "k2", TunnelIP: "10.100.0.3/32"},
	}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestValidateRoutesBothProtos(t *testing.T) {
	c := sampleBase()
	c.Forwarding = Forwarding{
		Routes: []ForwardRoute{
			{Proto: "both", Ports: []string{"7777"}, TargetIP: "10.100.0.2"},
			{Proto: "udp,tcp", Ports: []string{"8888"}, TargetIP: "10.100.0.2"},
		},
	}
	c.Peers = []Peer{{Name: "a", PublicKey: "k1", TunnelIP: "10.100.0.2/32"}}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestParseRouteProtocols(t *testing.T) {
	tests := []struct {
		in   string
		want []string
	}{
		{"tcp", []string{"tcp"}},
		{"UDP", []string{"udp"}},
		{"both", []string{"tcp", "udp"}},
		{"tcp, udp", []string{"tcp", "udp"}},
		{"udp+tcp", []string{"tcp", "udp"}},
		{"tcp,tcp", []string{"tcp"}},
	}
	for _, tt := range tests {
		got, err := ParseRouteProtocols(tt.in)
		if err != nil {
			t.Fatalf("%q: %v", tt.in, err)
		}
		if len(got) != len(tt.want) {
			t.Fatalf("%q: got %v want %v", tt.in, got, tt.want)
		}
		for i := range got {
			if got[i] != tt.want[i] {
				t.Fatalf("%q: got %v want %v", tt.in, got, tt.want)
			}
		}
	}
	if _, err := ParseRouteProtocols("sctp"); err == nil {
		t.Fatal("expected error for invalid proto")
	}
}

func TestValidateRoutesBadTarget(t *testing.T) {
	c := sampleBase()
	c.Forwarding = Forwarding{
		Routes: []ForwardRoute{
			{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.99.0.9"},
		},
	}
	c.Peers = []Peer{{Name: "a", PublicKey: "k", TunnelIP: "10.100.0.2/32"}}
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for unknown target_ip")
	}
}

func sampleBase() *Config {
	return &Config{
		WireGuard: WireGuard{
			Interface:      "evu0",
			ListenPort:     51830,
			PrivateKeyFile: "/x/key",
			Address:        "10.100.0.1/24",
		},
		Network: Network{PublicInterface: "eth0"},
		Geo:     Geo{Enabled: false},
	}
}
