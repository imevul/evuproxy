package apply

import (
	"context"
	"errors"
	"fmt"
	"os"
	"slices"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// ErrConfigRevisionMismatch means config.yaml no longer has the revision the caller
// based its save on (see SaveConfigYAMLIfMatch).
var ErrConfigRevisionMismatch = errors.New("config revision mismatch")

// SaveConfigYAML writes a validated config to path (atomic replace).
// It does not modify config backup/history files; those update on successful Reload only.
// A cross-process lock serializes it against reload/restore so a save cannot race
// a concurrent apply reading the same file.
func SaveConfigYAML(path string, c *config.Config) error {
	_, err := SaveConfigYAMLIfMatch(path, c, nil)
	return err
}

// SaveConfigYAMLIfMatch is SaveConfigYAML with an optimistic concurrency check: when
// revisions is non-nil, the current file must hash to one of them or the save fails
// with ErrConfigRevisionMismatch. The check runs under the apply lock so CLI edits
// cannot slip in between it and the write, and before validation so a stale draft
// reports the conflict rather than an error caused by its out-of-date contents.
// A revision is state.ConfigFileSHA256 of the file; the new one is returned.
func SaveConfigYAMLIfMatch(path string, c *config.Config, revisions []string) (string, error) {
	c.Normalize()
	unlock, err := acquireApplyLock(context.Background(), path)
	if err != nil {
		return "", err
	}
	defer unlock()
	if revisions != nil {
		cur, err := state.ConfigFileSHA256(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		if err != nil || !slices.Contains(revisions, cur) {
			return "", ErrConfigRevisionMismatch
		}
	}
	if err := c.Validate(); err != nil {
		// Most Validate checks still return plain errors; wrap so the API can
		// surface the message (and a stable code) instead of a generic save failure.
		var ve *config.ValidationError
		if errors.As(err, &ve) {
			return "", err
		}
		return "", &config.ValidationError{Code: "config_invalid", Msg: err.Error()}
	}
	out, err := yaml.Marshal(c)
	if err != nil {
		return "", fmt.Errorf("marshal yaml: %w", err)
	}
	if err := writeAtomic(path, out, 0o644); err != nil {
		return "", err
	}
	return state.ConfigFileSHA256(path)
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
