package apply

import "testing"

func TestFilterDropLines(t *testing.T) {
	in := "noise\nkernel: evuproxy-geo-block: IN=eth0 SRC=1.2.3.4\nother\n"
	got := filterDropLines(in)
	if len(got) != 1 || got[0] != "kernel: evuproxy-geo-block: IN=eth0 SRC=1.2.3.4" {
		t.Fatalf("unexpected: %#v", got)
	}
}

func TestHeadLimit(t *testing.T) {
	a := []string{"a", "b", "c"}
	if s := headLimit(a, 2); len(s) != 2 || s[0] != "a" || s[1] != "b" {
		t.Fatal(s)
	}
}
