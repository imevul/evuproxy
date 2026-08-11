package config

import (
	"errors"
	"strings"
	"testing"
)

func TestValidate_routeTargetDisabledPeer(t *testing.T) {
	c := &Config{
		WireGuard: WireGuard{
			Interface:      "wg0",
			ListenPort:     51820,
			PrivateKeyFile: "/key",
			Address:        "10.100.0.1/24",
		},
		Network: Network{PublicInterface: "eth0"},
		Peers: []Peer{
			{Name: "a", PublicKey: testWGKeyA, TunnelIP: "10.100.0.2/32", Disabled: true},
		},
		Forwarding: Forwarding{
			Routes: []ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
			},
		},
	}
	err := c.Validate()
	if err == nil {
		t.Fatal("expected route_target_peer_disabled")
	}
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("want ValidationError, got %T %v", err, err)
	}
	if ve.Code != "route_target_peer_disabled" {
		t.Fatalf("code %q", ve.Code)
	}
	if !strings.Contains(ve.Msg, "disable or retarget") {
		t.Fatalf("msg should guide operator: %q", ve.Msg)
	}
}
