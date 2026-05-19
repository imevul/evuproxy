package config

// CrowdSec optional integration with CrowdSec nftables bouncer (off by default).
type CrowdSec struct {
	Enabled bool `yaml:"enabled,omitempty" json:"enabled,omitempty"`
}
