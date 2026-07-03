package config

import "fmt"

// Rate limit bounds (inclusive). Zero means unset / disabled for that field.
const (
	RateLimitMinTCPSynPerSecond = 1
	RateLimitMaxTCPSynPerSecond = 10000
	RateLimitMinMaxConnPerIP    = 1
	RateLimitMaxMaxConnPerIP    = 65535
	RateLimitMinUDPPerSecond    = 1
	RateLimitMaxUDPPerSecond    = 100000
)

// RateLimit optional per-route or global forward rate limits (off when all fields zero).
type RateLimit struct {
	TCPSynPerSecond uint `yaml:"tcp_syn_per_second,omitempty" json:"tcp_syn_per_second,omitempty"`
	MaxConnPerIP    uint `yaml:"max_conn_per_ip,omitempty" json:"max_conn_per_ip,omitempty"`
	UDPPerSecond    uint `yaml:"udp_per_second,omitempty" json:"udp_per_second,omitempty"`
}

func (r RateLimit) Enabled() bool {
	return r.TCPSynPerSecond > 0 || r.MaxConnPerIP > 0 || r.UDPPerSecond > 0
}

func ValidateRateLimit(path string, r RateLimit) error {
	if !r.Enabled() {
		return nil
	}
	if r.TCPSynPerSecond > 0 {
		if r.TCPSynPerSecond < RateLimitMinTCPSynPerSecond || r.TCPSynPerSecond > RateLimitMaxTCPSynPerSecond {
			return fmt.Errorf("%s.tcp_syn_per_second must be between %d and %d", path, RateLimitMinTCPSynPerSecond, RateLimitMaxTCPSynPerSecond)
		}
	}
	if r.MaxConnPerIP > 0 {
		if r.MaxConnPerIP < RateLimitMinMaxConnPerIP || r.MaxConnPerIP > RateLimitMaxMaxConnPerIP {
			return fmt.Errorf("%s.max_conn_per_ip must be between %d and %d", path, RateLimitMinMaxConnPerIP, RateLimitMaxMaxConnPerIP)
		}
	}
	if r.UDPPerSecond > 0 {
		if r.UDPPerSecond < RateLimitMinUDPPerSecond || r.UDPPerSecond > RateLimitMaxUDPPerSecond {
			return fmt.Errorf("%s.udp_per_second must be between %d and %d", path, RateLimitMinUDPPerSecond, RateLimitMaxUDPPerSecond)
		}
	}
	return nil
}
