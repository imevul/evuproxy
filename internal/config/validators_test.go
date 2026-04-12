package config

import "testing"

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
