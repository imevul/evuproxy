package config

import "testing"

func TestValidateRateLimit_bounds(t *testing.T) {
	if err := ValidateRateLimit("forwarding.rate_limit", RateLimit{TCPSynPerSecond: 0}); err != nil {
		t.Fatal(err)
	}
	if err := ValidateRateLimit("forwarding.rate_limit", RateLimit{TCPSynPerSecond: 10001}); err == nil {
		t.Fatal("expected error")
	}
	if err := ValidateRateLimit("forwarding.rate_limit", RateLimit{MaxConnPerIP: 1, UDPPerSecond: 1}); err != nil {
		t.Fatal(err)
	}
}
