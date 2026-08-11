package apply

import (
	"context"
	"errors"
	"fmt"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// SaveConfigYAML writes a validated config to path (atomic replace).
// It does not modify config backup/history files; those update on successful Reload only.
// A cross-process lock serializes it against reload/restore so a save cannot race
// a concurrent apply reading the same file.
func SaveConfigYAML(path string, c *config.Config) error {
	c.Normalize()
	if err := c.Validate(); err != nil {
		// Most Validate checks still return plain errors; wrap so the API can
		// surface the message (and a stable code) instead of a generic save failure.
		var ve *config.ValidationError
		if errors.As(err, &ve) {
			return err
		}
		return &config.ValidationError{Code: "config_invalid", Msg: err.Error()}
	}
	unlock, err := acquireApplyLock(context.Background(), path)
	if err != nil {
		return err
	}
	defer unlock()
	out, err := yaml.Marshal(c)
	if err != nil {
		return fmt.Errorf("marshal yaml: %w", err)
	}
	if err := writeAtomic(path, out, 0o644); err != nil {
		return err
	}
	return nil
}

// DiscardPendingConfigYAML reverts config.yaml to the last applied snapshot,
// holding the cross-process apply lock so it cannot race a concurrent reload
// reading the same file.
func DiscardPendingConfigYAML(cfgPath string) error {
	unlock, err := acquireApplyLock(context.Background(), cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	return state.DiscardPendingConfigYAML(cfgPath)
}

// RestorePreviousAppliedConfigYAML writes the previous applied snapshot into
// config.yaml under the cross-process apply lock.
func RestorePreviousAppliedConfigYAML(cfgPath string) error {
	unlock, err := acquireApplyLock(context.Background(), cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	return state.RestorePreviousAppliedConfigYAML(cfgPath)
}
