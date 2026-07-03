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
		WireGuardServerEndpoint:  "vpn.example:51830",
		MetricsCollectionEnabled: true,
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

func TestUIPreferencesMigrateLegacyShowPeerLatency(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte("wireguard:\n  interface: x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prefsPath := filepath.Join(dir, "ui-preferences.json")
	if err := os.WriteFile(prefsPath, []byte(`{"peer_tunnel_subnet_cidr":"10.0.0.0/24","show_peer_latency":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := LoadUIPreferences(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !got.MetricsCollectionEnabled {
		t.Fatal("expected MetricsCollectionEnabled true from legacy key")
	}
}

func TestApplyUIPreferencesPatchPartial(t *testing.T) {
	base := UIPreferences{
		PeerTunnelSubnetCIDR:     "10.0.0.0/24",
		WireGuardServerEndpoint:  "vpn:51830",
		MetricsCollectionEnabled: true,
	}
	got := ApplyUIPreferencesPatch(base, &UIPreferencesPatch{})
	if got != base {
		t.Fatalf("empty patch: got %+v want %+v", got, base)
	}
	off := false
	gotOff := ApplyUIPreferencesPatch(base, &UIPreferencesPatch{MetricsCollectionEnabled: &off})
	if gotOff.MetricsCollectionEnabled {
		t.Fatal("expected MetricsCollectionEnabled false")
	}
	cidr := "192.168.0.0/24"
	gotCIDR := ApplyUIPreferencesPatch(base, &UIPreferencesPatch{PeerTunnelSubnetCIDR: &cidr})
	if gotCIDR.PeerTunnelSubnetCIDR != cidr || !gotCIDR.MetricsCollectionEnabled || gotCIDR.WireGuardServerEndpoint != base.WireGuardServerEndpoint {
		t.Fatalf("partial cidr: %+v", gotCIDR)
	}
	partial := UIPreferencesPatch{WireGuardServerEndpoint: ptrString("other:1")}
	gotP := ApplyUIPreferencesPatch(base, &partial)
	if gotP.WireGuardServerEndpoint != "other:1" || !gotP.MetricsCollectionEnabled || gotP.PeerTunnelSubnetCIDR != base.PeerTunnelSubnetCIDR {
		t.Fatalf("endpoint only: %+v", gotP)
	}
}

func TestUIPreferencesPatchLegacyShowPeerLatency(t *testing.T) {
	base := UIPreferences{MetricsCollectionEnabled: false}
	on := true
	got := ApplyUIPreferencesPatch(base, &UIPreferencesPatch{LegacyShowPeerLatency: &on})
	if !got.MetricsCollectionEnabled {
		t.Fatal("legacy show_peer_latency patch should set MetricsCollectionEnabled")
	}
}

func ptrString(s string) *string { return &s }
