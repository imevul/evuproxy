package apply

import (
	"fmt"
	"os"

	"github.com/imevul/evuproxy/internal/config"
	"gopkg.in/yaml.v3"
)

// ConfigYAMLBackupPath returns the path used for the single-level config backup (before replace).
func ConfigYAMLBackupPath(cfgPath string) string {
	return cfgPath + ".bak"
}

// SaveConfigYAML writes a validated config to path (atomic replace).
// If path already exists, its current contents are written to ConfigYAMLBackupPath first.
func SaveConfigYAML(path string, c *config.Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	out, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal yaml: %w", err)
	}
	if _, err := os.Stat(path); err == nil {
		prev, err := os.ReadFile(path)
		if err != nil {
			return fmt.Errorf("read config for backup: %w", err)
		}
		bak := ConfigYAMLBackupPath(path)
		if err := writeAtomic(bak, prev, 0o644); err != nil {
			return fmt.Errorf("write config backup: %w", err)
		}
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("stat config: %w", err)
	}
	if err := writeAtomic(path, out, 0o644); err != nil {
		return err
	}
	return nil
}

// UndoConfigYAML swaps the on-disk config with ConfigYAMLBackupPath contents (redo: run again).
// Backup bytes must unmarshal to a valid config.
func UndoConfigYAML(cfgPath string) error {
	bakPath := ConfigYAMLBackupPath(cfgPath)
	bak, err := os.ReadFile(bakPath)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("no config backup")
		}
		return fmt.Errorf("read backup: %w", err)
	}
	var c config.Config
	if err := yaml.Unmarshal(bak, &c); err != nil {
		return fmt.Errorf("backup yaml: %w", err)
	}
	if err := c.Validate(); err != nil {
		return fmt.Errorf("backup invalid: %w", err)
	}
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	if err := writeAtomic(cfgPath, bak, 0o644); err != nil {
		return fmt.Errorf("write config: %w", err)
	}
	if err := writeAtomic(bakPath, cur, 0o644); err != nil {
		return fmt.Errorf("swap: config reverted but backup file may be stale: %w", err)
	}
	return nil
}
