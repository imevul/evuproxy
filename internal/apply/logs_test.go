package apply

import "testing"

func TestFilterDropLines(t *testing.T) {
	in := "noise\nkernel: evuproxy-geo-block: IN=eth0 SRC=1.2.3.4\nkernel: evuproxy-ratelimit: IN=eth0 SRC=5.6.7.8\nkernel: evuproxy-crowdsec: IN=eth0 SRC=9.9.9.9\nother\n"
	got := filterDropLines(in)
	if len(got) != 3 {
		t.Fatalf("unexpected: %#v", got)
	}
}

func TestHeadLimit(t *testing.T) {
	a := []string{"a", "b", "c"}
	if s := headLimit(a, 2); len(s) != 2 || s[0] != "a" || s[1] != "b" {
		t.Fatal(s)
	}
}
