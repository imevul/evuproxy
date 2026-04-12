package apply

import (
	"fmt"

	"github.com/imevul/evuproxy/internal/config"
	"gopkg.in/yaml.v3"
)

// SaveConfigYAML writes a validated config to path (atomic replace).
func SaveConfigYAML(path string, c *config.Config) error {
	if err := c.Validate(); err != nil {
		return err
	}
	out, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal yaml: %w", err)
	}
	if err := writeAtomic(path, out, 0o644); err != nil {
		return err
	}
	return nil
}
