package apply

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

type applyStateFile struct {
	ConfigSHA256 string `json:"config_sha256"`
}

func applyStatePath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), ".evuproxy-last-applied.json")
}

// ConfigFileSHA256 returns a hex-encoded SHA-256 of the raw config file bytes.
func ConfigFileSHA256(cfgPath string) (string, error) {
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func readAppliedHash(cfgPath string) (string, error) {
	p := applyStatePath(cfgPath)
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	var st applyStateFile
	if err := json.Unmarshal(b, &st); err != nil {
		return "", fmt.Errorf("apply state: %w", err)
	}
	return st.ConfigSHA256, nil
}

// WriteAppliedConfigHash records the SHA-256 of the on-disk config as last applied (after reload).
func WriteAppliedConfigHash(cfgPath string, hash string) error {
	st := applyStateFile{ConfigSHA256: hash}
	b, err := json.Marshal(st)
	if err != nil {
		return err
	}
	return writeAtomic(applyStatePath(cfgPath), b, 0o644)
}

// RecordAppliedConfigHash writes the current on-disk config hash as last-applied.
func RecordAppliedConfigHash(cfgPath string) error {
	h, err := ConfigFileSHA256(cfgPath)
	if err != nil {
		return err
	}
	return WriteAppliedConfigHash(cfgPath, h)
}

// EnsureApplyStateFromDisk creates apply state if missing, assuming the current config file
// matches what is already running (typical right after API server start).
func EnsureApplyStateFromDisk(cfgPath string) error {
	p := applyStatePath(cfgPath)
	if _, err := os.Stat(p); err == nil {
		return nil
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := RecordAppliedConfigHash(cfgPath); err != nil {
		return err
	}
	slog.Info("apply state initialized from current on-disk config (first run or missing state file)", "path", p)
	return nil
}

// PendingInfo describes whether disk config differs from last successful apply and shows generated nftables.
type PendingInfo struct {
	Pending             bool   `json:"pending"`
	CurrentConfigSHA256 string `json:"current_config_sha256"`
	AppliedConfigSHA256 string `json:"applied_config_sha256"`
	NFTables            string `json:"nftables"`
	// NFTablesBaseline is the contents of generated/nftables.nft when readable (last written by reload).
	NFTablesBaseline string `json:"nftables_baseline"`
	// ConfigBackupAvailable is true when ConfigYAMLBackupPath exists (from a prior save that replaced the file).
	ConfigBackupAvailable bool `json:"config_backup_available"`
}

// PendingSummary loads the on-disk config, compares its hash to last apply, and renders nftables preview.
func PendingSummary(cfgPath string) (PendingInfo, error) {
	var out PendingInfo
	cur, err := ConfigFileSHA256(cfgPath)
	if err != nil {
		return out, err
	}
	out.CurrentConfigSHA256 = cur
	applied, err := readAppliedHash(cfgPath)
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
	if _, err := os.Stat(ConfigYAMLBackupPath(cfgPath)); err == nil {
		out.ConfigBackupAvailable = true
	}
	return out, nil
}
