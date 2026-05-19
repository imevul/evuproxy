package apply

import "testing"

func TestIPv4ContainedInCIDRs(t *testing.T) {
	cidrs := []string{"198.51.100.0/24", "203.0.113.5"}
	if !IPv4ContainedInCIDRs("203.0.113.5", cidrs) {
		t.Fatal("host match")
	}
	if !IPv4ContainedInCIDRs("198.51.100.42", cidrs) {
		t.Fatal("cidr match")
	}
	if IPv4ContainedInCIDRs("10.0.0.1", cidrs) {
		t.Fatal("expected no match")
	}
}
