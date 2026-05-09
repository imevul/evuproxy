package apply

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPeerTunnelSubnetCIDR is used when ui-preferences.json omits or clears peer_tunnel_subnet_cidr.
const DefaultPeerTunnelSubnetCIDR = "10.100.0.0/24"

// UIPreferences holds admin UI settings stored beside the main config (not part of WireGuard YAML).
type UIPreferences struct {
	PeerTunnelSubnetCIDR    string `json:"peer_tunnel_subnet_cidr"`
	WireGuardServerEndpoint string `json:"wireguard_server_endpoint"`
	// MetricsCollectionEnabled turns on background peer ICMP metrics when true (default false).
	MetricsCollectionEnabled bool `json:"metrics_collection_enabled,omitempty"`
}

func uiPrefsPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), "ui-preferences.json")
}

type uiPreferencesFile struct {
	PeerTunnelSubnetCIDR     string `json:"peer_tunnel_subnet_cidr"`
	WireGuardServerEndpoint  string `json:"wireguard_server_endpoint"`
	MetricsCollectionEnabled *bool  `json:"metrics_collection_enabled"`
	// Legacy: migrated once into MetricsCollectionEnabled when the new key is absent.
	ShowPeerLatency *bool `json:"show_peer_latency"`
}

// LoadUIPreferences reads ui-preferences.json; missing file or empty peer_tunnel_subnet_cidr
// yields DefaultPeerTunnelSubnetCIDR for that field.
func LoadUIPreferences(cfgPath string) (UIPreferences, error) {
	var out UIPreferences
	b, err := os.ReadFile(uiPrefsPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return NormalizeUIPreferences(out), nil
		}
		return out, err
	}
	var f uiPreferencesFile
	if err := json.Unmarshal(b, &f); err != nil {
		return out, fmt.Errorf("ui preferences: %w", err)
	}
	out.PeerTunnelSubnetCIDR = f.PeerTunnelSubnetCIDR
	out.WireGuardServerEndpoint = f.WireGuardServerEndpoint
	if f.MetricsCollectionEnabled != nil {
		out.MetricsCollectionEnabled = *f.MetricsCollectionEnabled
	} else if f.ShowPeerLatency != nil {
		out.MetricsCollectionEnabled = *f.ShowPeerLatency
	}
	return NormalizeUIPreferences(out), nil
}

// NormalizeUIPreferences applies defaults (e.g. empty subnet → DefaultPeerTunnelSubnetCIDR).
func NormalizeUIPreferences(p UIPreferences) UIPreferences {
	if strings.TrimSpace(p.PeerTunnelSubnetCIDR) == "" {
		p.PeerTunnelSubnetCIDR = DefaultPeerTunnelSubnetCIDR
	}
	return p
}

// MetricsDBDefaultPath returns the default SQLite path beside the main config (same directory).
func MetricsDBDefaultPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), "metrics.sqlite")
}

// UIPreferencesPatch is a partial update for PUT /preferences: nil fields mean "leave unchanged".
type UIPreferencesPatch struct {
	PeerTunnelSubnetCIDR     *string `json:"peer_tunnel_subnet_cidr"`
	WireGuardServerEndpoint  *string `json:"wireguard_server_endpoint"`
	MetricsCollectionEnabled *bool   `json:"metrics_collection_enabled"`
	LegacyShowPeerLatency    *bool   `json:"show_peer_latency"`
}

// ApplyUIPreferencesPatch merges non-nil patch fields into base.
func ApplyUIPreferencesPatch(base UIPreferences, p *UIPreferencesPatch) UIPreferences {
	if p == nil {
		return base
	}
	out := base
	if p.PeerTunnelSubnetCIDR != nil {
		out.PeerTunnelSubnetCIDR = strings.TrimSpace(*p.PeerTunnelSubnetCIDR)
	}
	if p.WireGuardServerEndpoint != nil {
		out.WireGuardServerEndpoint = strings.TrimSpace(*p.WireGuardServerEndpoint)
	}
	if p.MetricsCollectionEnabled != nil {
		out.MetricsCollectionEnabled = *p.MetricsCollectionEnabled
	} else if p.LegacyShowPeerLatency != nil {
		out.MetricsCollectionEnabled = *p.LegacyShowPeerLatency
	}
	return out
}

// SaveUIPreferences writes ui-preferences.json atomically.
func SaveUIPreferences(cfgPath string, p *UIPreferences) error {
	b, err := json.MarshalIndent(p, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(uiPrefsPath(cfgPath), b, 0o644); err != nil {
		return err
	}
	return nil
}
