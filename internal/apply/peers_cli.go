package apply

import (
	"fmt"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// RemovePeerByNameOrKey removes the first matching peer from cfg (not persisted).
func RemovePeerByNameOrKey(cfg *config.Config, name, publicKey string) error {
	if cfg == nil {
		return fmt.Errorf("config is nil")
	}
	name = strings.TrimSpace(name)
	publicKey = strings.TrimSpace(publicKey)
	if name == "" && publicKey == "" {
		return fmt.Errorf("at least one of --name or --public-key is required")
	}
	both := name != "" && publicKey != ""
	var kept []config.Peer
	var removed bool
	for _, p := range cfg.Peers {
		nameMatch := name != "" && strings.EqualFold(strings.TrimSpace(p.Name), name)
		keyMatch := publicKey != "" && strings.TrimSpace(p.PublicKey) == publicKey
		match := nameMatch || keyMatch
		if both {
			match = nameMatch && keyMatch
		}
		if match {
			removed = true
			continue
		}
		kept = append(kept, p)
	}
	if !removed {
		return fmt.Errorf("no peer matched name %q / public-key", name)
	}
	cfg.Peers = kept
	return cfg.Validate()
}

// PeerSetUpdates holds optional peer field updates from peer-set.
type PeerSetUpdates struct {
	NewName   string
	TunnelIP  string
	PublicKey string
	Disabled  *bool
}

// UpdatePeerByName updates the first peer with the given name.
func UpdatePeerByName(cfg *config.Config, name string, upd PeerSetUpdates) error {
	if cfg == nil {
		return fmt.Errorf("config is nil")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("--name is required")
	}
	var found bool
	for i := range cfg.Peers {
		if !strings.EqualFold(strings.TrimSpace(cfg.Peers[i].Name), name) {
			continue
		}
		found = true
		if nn := strings.TrimSpace(upd.NewName); nn != "" {
			for j, p := range cfg.Peers {
				if j != i && !p.Disabled && strings.EqualFold(strings.TrimSpace(p.Name), nn) {
					return fmt.Errorf("peer named %q already exists", nn)
				}
			}
			cfg.Peers[i].Name = nn
		}
		if tun := strings.TrimSpace(upd.TunnelIP); tun != "" {
			cfg.Peers[i].TunnelIP = tun
		}
		if pk := strings.TrimSpace(upd.PublicKey); pk != "" {
			cfg.Peers[i].PublicKey = pk
		}
		if upd.Disabled != nil {
			cfg.Peers[i].Disabled = *upd.Disabled
		}
		break
	}
	if !found {
		return fmt.Errorf("peer %q not found", name)
	}
	return cfg.Validate()
}
