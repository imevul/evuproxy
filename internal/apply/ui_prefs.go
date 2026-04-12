package apply

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// UIPreferences holds admin UI settings stored beside the main config (not part of WireGuard YAML).
type UIPreferences struct {
	PeerTunnelSubnetCIDR     string `json:"peer_tunnel_subnet_cidr"`
	WireGuardServerEndpoint string `json:"wireguard_server_endpoint"`
}

func uiPrefsPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), "ui-preferences.json")
}

// LoadUIPreferences reads ui-preferences.json; missing file returns zero values.
func LoadUIPreferences(cfgPath string) (UIPreferences, error) {
	var out UIPreferences
	b, err := os.ReadFile(uiPrefsPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return out, nil
		}
		return out, err
	}
	if err := json.Unmarshal(b, &out); err != nil {
		return out, fmt.Errorf("ui preferences: %w", err)
	}
	return out, nil
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
