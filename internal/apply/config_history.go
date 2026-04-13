package apply

import (
	"bytes"
	"fmt"
	"os"
	"strconv"

	"github.com/imevul/evuproxy/internal/config"
	"gopkg.in/yaml.v3"
)

func configYAMLBackupNth(cfgPath string, n int) string {
	return cfgPath + ".bak." + strconv.Itoa(n)
}

func validateConfigYAMLBytes(b []byte) error {
	var c config.Config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return err
	}
	return c.Validate()
}

// RecordAppliedConfigSnapshot updates config.yaml.bak and rotated .bak.1 … .bak.5 after a successful Reload.
// If .bak is missing, it is created from current config. If current bytes equal .bak, does nothing.
// If they differ, rotates the chain then writes current config to .bak.
func RecordAppliedConfigSnapshot(cfgPath string) error {
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		return err
	}
	bakPath := ConfigYAMLBackupPath(cfgPath)
	prevBak, err := os.ReadFile(bakPath)
	if err != nil {
		if os.IsNotExist(err) {
			return writeAtomic(bakPath, cur, 0o644)
		}
		return err
	}
	if bytes.Equal(cur, prevBak) {
		return nil
	}
	bak5 := configYAMLBackupNth(cfgPath, 5)
	_ = os.Remove(bak5)
	for i := 4; i >= 1; i-- {
		from := configYAMLBackupNth(cfgPath, i)
		to := configYAMLBackupNth(cfgPath, i+1)
		if _, err := os.Stat(from); err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return err
		}
		if err := os.Rename(from, to); err != nil {
			return fmt.Errorf("rotate %s -> %s: %w", from, to, err)
		}
	}
	if err := os.Rename(bakPath, configYAMLBackupNth(cfgPath, 1)); err != nil {
		return fmt.Errorf("rotate bak -> bak.1: %w", err)
	}
	return writeAtomic(bakPath, cur, 0o644)
}

// DiscardPendingConfigYAML replaces config.yaml with config.yaml.bak when they differ.
func DiscardPendingConfigYAML(cfgPath string) error {
	bakPath := ConfigYAMLBackupPath(cfgPath)
	bak, err := os.ReadFile(bakPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no applied snapshot (.bak)")
		}
		return fmt.Errorf("read backup: %w", err)
	}
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	if bytes.Equal(cur, bak) {
		return fmt.Errorf("no pending changes to discard")
	}
	if err := validateConfigYAMLBytes(bak); err != nil {
		return fmt.Errorf("backup invalid: %w", err)
	}
	return writeAtomic(cfgPath, bak, 0o644)
}

// RestorePreviousAppliedConfigYAML writes the first config.yaml.bak.N (N=1..5) that differs from .bak
// into config.yaml. Does not rotate or modify any .bak files. Overwrites any current config.yaml content.
func RestorePreviousAppliedConfigYAML(cfgPath string) error {
	bakPath := ConfigYAMLBackupPath(cfgPath)
	bak, err := os.ReadFile(bakPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no applied snapshot (.bak)")
		}
		return fmt.Errorf("read backup: %w", err)
	}
	var candidate []byte
	found := false
	for n := 1; n <= 5; n++ {
		p := configYAMLBackupNth(cfgPath, n)
		b, err := os.ReadFile(p)
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return fmt.Errorf("read %s: %w", p, err)
		}
		if !bytes.Equal(b, bak) {
			candidate = b
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("no previous applied config in history")
	}
	if err := validateConfigYAMLBytes(candidate); err != nil {
		return fmt.Errorf("history entry invalid: %w", err)
	}
	return writeAtomic(cfgPath, candidate, 0o644)
}

// RestorePreviousAppliedAvailable reports whether some .bak.N differs from .bak.
func RestorePreviousAppliedAvailable(cfgPath string) (bool, error) {
	bak, err := os.ReadFile(ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	for n := 1; n <= 5; n++ {
		b, err := os.ReadFile(configYAMLBackupNth(cfgPath, n))
		if err != nil {
			if os.IsNotExist(err) {
				continue
			}
			return false, err
		}
		if !bytes.Equal(b, bak) {
			return true, nil
		}
	}
	return false, nil
}
