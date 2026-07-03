package apply

import (
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestLockoutWarnings_maintenance(t *testing.T) {
	c := &config.Config{
		WireGuard:  config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:    config.Network{PublicInterface: "eth0"},
		Geo:        config.Geo{Enabled: false},
		Forwarding: config.Forwarding{MaintenanceMode: true},
		Peers:      []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	if len(w) != 1 || w[0].Code != "lockout_risk_maintenance" {
		t.Fatalf("got %+v", w)
	}
}

func TestLockoutWarnings_sourceDeny(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Geo:       config.Geo{Enabled: false},
		Forwarding: config.Forwarding{
			SourceDenyCIDRs: []string{"203.0.113.0/24"},
			Routes:          []config.ForwardRoute{{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"}},
		},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	found := false
	for _, x := range w {
		if x.Code == "lockout_risk_source_deny" {
			found = true
		}
	}
	if !found {
		t.Fatalf("got %+v", w)
	}
}

func TestLockoutWarnings_sourceAllow(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Geo:       config.Geo{Enabled: false},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{{
				Proto:            "tcp",
				Ports:            []string{"25565"},
				TargetIP:         "10.100.0.2",
				SourceAllowCIDRs: []string{"198.51.100.0/24"},
			}},
		},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	found := false
	for _, x := range w {
		if x.Code == "lockout_risk_source_allow" {
			found = true
		}
	}
	if !found {
		t.Fatalf("got %+v", w)
	}
}
