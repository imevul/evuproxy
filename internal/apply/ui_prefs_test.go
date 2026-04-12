package apply

import (
	"os"
	"path/filepath"
	"testing"
)

func TestUIPreferencesDefaultSubnetWhenMissingFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte("wireguard:\n  interface: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadUIPreferences(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if got.PeerTunnelSubnetCIDR != DefaultPeerTunnelSubnetCIDR {
		t.Fatalf("PeerTunnelSubnetCIDR got %q want %q", got.PeerTunnelSubnetCIDR, DefaultPeerTunnelSubnetCIDR)
	}
}

func TestUIPreferencesDefaultSubnetWhenEmptyInFile(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte("wireguard:\n  interface: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prefsPath := filepath.Join(dir, "ui-preferences.json")
	if err := os.WriteFile(prefsPath, []byte(`{"peer_tunnel_subnet_cidr":"","wireguard_server_endpoint":""}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadUIPreferences(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if got.PeerTunnelSubnetCIDR != DefaultPeerTunnelSubnetCIDR {
		t.Fatalf("PeerTunnelSubnetCIDR got %q want %q", got.PeerTunnelSubnetCIDR, DefaultPeerTunnelSubnetCIDR)
	}
}

func TestUIPreferencesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte("wireguard:\n  interface: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	want := UIPreferences{
		PeerTunnelSubnetCIDR:     "10.0.0.0/24",
		WireGuardServerEndpoint: "vpn.example:51830",
	}
	if err := SaveUIPreferences(cfgPath, &want); err != nil {
		t.Fatal(err)
	}
	got, err := LoadUIPreferences(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("got %+v want %+v", got, want)
	}
}
