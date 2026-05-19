package apply

import (
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func testPeerConfig(peers ...config.Peer) *config.Config {
	return &config.Config{
		WireGuard:  config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:    config.Network{PublicInterface: "eth0"},
		Geo:        config.Geo{Enabled: false},
		Forwarding: config.Forwarding{},
		Peers:      peers,
	}
}

func TestRemovePeerByNameOrKey(t *testing.T) {
	cfg := testPeerConfig(
		config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"},
		config.Peer{Name: "b", PublicKey: "pk2", TunnelIP: "10.100.0.3/32"},
	)
	if err := RemovePeerByNameOrKey(cfg, "a", ""); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Peers) != 1 || cfg.Peers[0].Name != "b" {
		t.Fatalf("got %+v", cfg.Peers)
	}
}

func TestRemovePeerByPublicKey(t *testing.T) {
	cfg := testPeerConfig(
		config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"},
		config.Peer{Name: "b", PublicKey: "pk2", TunnelIP: "10.100.0.3/32"},
	)
	if err := RemovePeerByNameOrKey(cfg, "", "pk2"); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Peers) != 1 || cfg.Peers[0].PublicKey != "pk1" {
		t.Fatalf("got %+v", cfg.Peers)
	}
}

func TestRemovePeerRequiresSelector(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	err := RemovePeerByNameOrKey(cfg, "", "")
	if err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("got %v", err)
	}
}

func TestRemovePeerNoMatch(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	err := RemovePeerByNameOrKey(cfg, "missing", "")
	if err == nil || !strings.Contains(err.Error(), "no peer matched") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdatePeerByName_tunnelAndDisabled(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	disabled := true
	if err := UpdatePeerByName(cfg, "a", PeerSetUpdates{TunnelIP: "10.100.0.9/32", Disabled: &disabled}); err != nil {
		t.Fatal(err)
	}
	p := cfg.Peers[0]
	if p.TunnelIP != "10.100.0.9/32" || !p.Disabled {
		t.Fatalf("got %+v", p)
	}
}

func TestUpdatePeerByName_rename(t *testing.T) {
	cfg := testPeerConfig(
		config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"},
		config.Peer{Name: "b", PublicKey: "pk2", TunnelIP: "10.100.0.3/32"},
	)
	if err := UpdatePeerByName(cfg, "a", PeerSetUpdates{NewName: "alpha"}); err != nil {
		t.Fatal(err)
	}
	if cfg.Peers[0].Name != "alpha" {
		t.Fatalf("got %+v", cfg.Peers[0])
	}
}

func TestUpdatePeerByName_renameConflict(t *testing.T) {
	cfg := testPeerConfig(
		config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"},
		config.Peer{Name: "b", PublicKey: "pk2", TunnelIP: "10.100.0.3/32"},
	)
	err := UpdatePeerByName(cfg, "a", PeerSetUpdates{NewName: "b"})
	if err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdatePeerByName_notFound(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	err := UpdatePeerByName(cfg, "missing", PeerSetUpdates{TunnelIP: "10.100.0.9/32"})
	if err == nil || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdatePeerByName_requiresName(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	err := UpdatePeerByName(cfg, "", PeerSetUpdates{TunnelIP: "10.100.0.9/32"})
	if err == nil || !strings.Contains(err.Error(), "required") {
		t.Fatalf("got %v", err)
	}
}

func TestUpdatePeerByName_publicKey(t *testing.T) {
	cfg := testPeerConfig(config.Peer{Name: "a", PublicKey: "pk1", TunnelIP: "10.100.0.2/32"})
	if err := UpdatePeerByName(cfg, "a", PeerSetUpdates{PublicKey: "pk-new"}); err != nil {
		t.Fatal(err)
	}
	if cfg.Peers[0].PublicKey != "pk-new" {
		t.Fatalf("got %q", cfg.Peers[0].PublicKey)
	}
}
