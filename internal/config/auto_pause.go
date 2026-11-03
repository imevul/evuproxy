package config

import (
	"fmt"
	"strings"
	"time"
)

// Auto-pause defaults and bounds (inclusive). Zero or empty fields use the defaults.
const (
	DefaultAutoPauseFailuresToPause   = 3
	DefaultAutoPauseSuccessesToResume = 2
	DefaultAutoPauseInterval          = 15 * time.Second
	AutoPauseMaxThreshold             = 100
	AutoPauseMinInterval              = 5 * time.Second
	AutoPauseMaxInterval              = time.Hour
)

// AutoPause holds the global settings for routes with pause_when_peer_offline.
// Pause state is runtime-only and is never written back to config.
type AutoPause struct {
	// FailuresToPause is how many consecutive offline probes pause a peer's routes.
	FailuresToPause int `yaml:"failures_to_pause,omitempty" json:"failures_to_pause,omitempty"`
	// SuccessesToResume is how many consecutive online probes resume a peer's routes.
	SuccessesToResume int `yaml:"successes_to_resume,omitempty" json:"successes_to_resume,omitempty"`
	// Interval is the time between probes as a Go duration (e.g. 15s).
	Interval string `yaml:"interval,omitempty" json:"interval,omitempty"`
	// ICMPFallback pings a peer over the tunnel when its WireGuard handshake is stale.
	ICMPFallback bool `yaml:"icmp_fallback,omitempty" json:"icmp_fallback,omitempty"`
}

// EffectiveFailuresToPause returns the configured threshold, or the default when unset.
func (a AutoPause) EffectiveFailuresToPause() int {
	if a.FailuresToPause > 0 {
		return a.FailuresToPause
	}
	return DefaultAutoPauseFailuresToPause
}

// EffectiveSuccessesToResume returns the configured threshold, or the default when unset.
func (a AutoPause) EffectiveSuccessesToResume() int {
	if a.SuccessesToResume > 0 {
		return a.SuccessesToResume
	}
	return DefaultAutoPauseSuccessesToResume
}

// EffectiveInterval returns the configured probe interval, or the default when unset or invalid.
func (a AutoPause) EffectiveInterval() time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(a.Interval))
	if err != nil {
		return DefaultAutoPauseInterval
	}
	return d
}

// ValidateAutoPause checks thresholds and the probe interval.
func ValidateAutoPause(a AutoPause) error {
	if a.FailuresToPause < 0 || a.FailuresToPause > AutoPauseMaxThreshold {
		return fmt.Errorf("auto_pause.failures_to_pause must be between 1 and %d", AutoPauseMaxThreshold)
	}
	if a.SuccessesToResume < 0 || a.SuccessesToResume > AutoPauseMaxThreshold {
		return fmt.Errorf("auto_pause.successes_to_resume must be between 1 and %d", AutoPauseMaxThreshold)
	}
	s := strings.TrimSpace(a.Interval)
	if s == "" {
		return nil
	}
	d, err := time.ParseDuration(s)
	if err != nil {
		return fmt.Errorf("auto_pause.interval: %w", err)
	}
	if d < AutoPauseMinInterval || d > AutoPauseMaxInterval {
		return fmt.Errorf("auto_pause.interval must be between %s and %s", AutoPauseMinInterval, AutoPauseMaxInterval)
	}
	return nil
}
