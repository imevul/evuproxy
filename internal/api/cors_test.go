package api

import "testing"

func TestParseCORSOrigins(t *testing.T) {
	t.Parallel()
	if parseCORSOrigins("") != nil {
		t.Fatal("empty should disable")
	}
	if parseCORSOrigins("  ") != nil {
		t.Fatal("whitespace-only should disable")
	}
	all := parseCORSOrigins("*")
	if all == nil || !all.allowAll || all.origins != nil {
		t.Fatalf("*: %+v", all)
	}
	multi := parseCORSOrigins(" https://a.test , http://b:9 ")
	if multi == nil || multi.allowAll {
		t.Fatalf("multi: %+v", multi)
	}
	if _, ok := multi.origins["https://a.test"]; !ok {
		t.Fatal("missing https://a.test")
	}
	if _, ok := multi.origins["http://b:9"]; !ok {
		t.Fatal("missing http://b:9")
	}
}

func TestCORSRuleAllow(t *testing.T) {
	t.Parallel()
	r := parseCORSOrigins("https://ui.example")
	v, ok := r.allow("https://ui.example")
	if !ok || v != "https://ui.example" {
		t.Fatalf("got %q %v", v, ok)
	}
	_, ok = r.allow("https://evil.example")
	if ok {
		t.Fatal("unexpected allow")
	}
	all := parseCORSOrigins("*")
	v, ok = all.allow("anything")
	if !ok || v != "*" {
		t.Fatalf("allow-all: %q %v", v, ok)
	}
}
