package apply

import (
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
	"github.com/imevul/evuproxy/internal/state"
)

// PendingInfo describes whether disk config differs from last successful apply and shows generated nftables.
type PendingInfo struct {
	Pending             bool   `json:"pending"`
	CurrentConfigSHA256 string `json:"current_config_sha256"`
	AppliedConfigSHA256 string `json:"applied_config_sha256"`
	NFTables            string `json:"nftables"`
	// NFTablesBaseline is the contents of generated/nftables.nft when readable (last written by reload).
	NFTablesBaseline string `json:"nftables_baseline"`
	// DiscardAvailable is true when .bak exists and config.yaml differs from it (pending edits vs last applied snapshot).
	DiscardAvailable bool `json:"discard_available"`
	// RestorePreviousAppliedAvailable is true when some .bak.N differs from .bak.
	RestorePreviousAppliedAvailable bool `json:"restore_previous_applied_available"`
}

// PendingSummary loads the on-disk config, compares its hash to last apply, and renders nftables preview.
func PendingSummary(cfgPath string) (PendingInfo, error) {
	var out PendingInfo
	cur, err := state.ConfigFileSHA256(cfgPath)
	if err != nil {
		return out, err
	}
	out.CurrentConfigSHA256 = cur
	applied, err := state.ReadAppliedHash(cfgPath)
	if err != nil {
		return out, err
	}
	out.AppliedConfigSHA256 = applied
	// No recorded apply (e.g. state file missing/unwritable) → treat as unsafe to assume sync.
	out.Pending = applied == "" || cur != applied
	c, err := config.Load(cfgPath)
	if err != nil {
		return out, err
	}
	nft, err := gen.NFTables(c)
	if err != nil {
		return out, err
	}
	out.NFTables = nft
	nftPath := filepath.Join(filepath.Dir(cfgPath), GeneratedDir, "nftables.nft")
	if b, err := os.ReadFile(nftPath); err == nil {
		out.NFTablesBaseline = string(b)
	} else if !os.IsNotExist(err) {
		slog.Debug("pending: could not read nftables baseline file", "path", nftPath, "err", err)
	}
	if bakBytes, err := os.ReadFile(state.ConfigYAMLBackupPath(cfgPath)); err == nil {
		bh := sha256.Sum256(bakBytes)
		bakHex := hex.EncodeToString(bh[:])
		out.DiscardAvailable = cur != bakHex
		ra, err := state.RestorePreviousAppliedAvailable(cfgPath)
		if err != nil {
			slog.Debug("pending: restore-previous check", "err", err)
		} else {
			out.RestorePreviousAppliedAvailable = ra
		}
	}
	return out, nil
}
