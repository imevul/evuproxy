package config

import (
	"errors"
	"testing"
)

func TestExpandRoutePortNumbers_braceAndRange(t *testing.T) {
	got, err := ExpandRoutePortNumbers([]string{"{80,443}", "9000-9002"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 5 {
		t.Fatalf("got %v len %d", got, len(got))
	}
}

func TestExpandRoutePortNumbers_largeRange(t *testing.T) {
	got, err := ExpandRoutePortNumbers([]string{"20000-40000"})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 20001 {
		t.Fatalf("len %d want 20001", len(got))
	}
	if got[0] != 20000 || got[len(got)-1] != 40000 {
		t.Fatalf("bounds %d..%d", got[0], got[len(got)-1])
	}
}

func TestValidate_routePortOverlap(t *testing.T) {
	c := &Config{
		WireGuard: WireGuard{
			Interface: "wg0",
			ListenPort:     51820,
			PrivateKeyFile: "/key",
			Address:        "10.100.0.1/24",
		},
		Network: Network{PublicInterface: "eth0"},
		Peers: []Peer{
			{Name: "a", PublicKey: "k1", TunnelIP: "10.100.0.2/32"},
			{Name: "b", PublicKey: "k2", TunnelIP: "10.100.0.3/32"},
		},
		Forwarding: Forwarding{
			Routes: []ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.3"},
			},
		},
	}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected overlap error")
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("want ValidationError, got %T %v", err, err)
	}
	if ve.Code != "route_port_overlap" {
		t.Fatalf("code %q", ve.Code)
	}
}
