package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/imevul/evuproxy/internal/atomicio"
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

// ReadAppliedHash returns the recorded last-applied config hash ("" when no state file exists).
func ReadAppliedHash(cfgPath string) (string, error) {
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
	return atomicio.WriteFile(applyStatePath(cfgPath), b, 0o644)
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
