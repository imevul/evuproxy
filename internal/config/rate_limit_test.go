package config

import "testing"

func TestEffectiveRateLimit_routeOverrides(t *testing.T) {
	global := RateLimit{TCPSynPerSecond: 50, MaxConnPerIP: 100}
	route := RateLimit{TCPSynPerSecond: 20, UDPPerSecond: 500}
	got := EffectiveRateLimit(global, route)
	if got.TCPSynPerSecond != 20 || got.MaxConnPerIP != 100 || got.UDPPerSecond != 500 {
		t.Fatalf("got %+v", got)
	}
}

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
