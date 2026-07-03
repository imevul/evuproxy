package api

import (
	"net/http/httptest"
	"os"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
)

func TestDetectClientIP_direct(t *testing.T) {
	t.Setenv("EVUPROXY_TRUST_XFF", "")
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "203.0.113.5:12345"
	info := DetectClientIP(r)
	if info.IP != "203.0.113.5" || info.Source != apply.ClientIPSourceDirect {
		t.Fatalf("got %+v", info)
	}
}

func TestDetectClientIP_xffIgnoredByDefault(t *testing.T) {
	t.Setenv("EVUPROXY_TRUST_XFF", "")
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:9847"
	r.Header.Set("X-Forwarded-For", "203.0.113.9")
	info := DetectClientIP(r)
	if info.IP != "127.0.0.1" {
		t.Fatalf("got %+v", info)
	}
}

func TestDetectClientIP_xffTrusted(t *testing.T) {
	t.Setenv("EVUPROXY_TRUST_XFF", "1")
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "127.0.0.1:9847"
	r.Header.Set("X-Forwarded-For", "203.0.113.9, 198.51.100.1")
	info := DetectClientIP(r)
	if info.IP != "203.0.113.9" || info.Source != apply.ClientIPSourceXFF {
		t.Fatalf("got %+v", info)
	}
}

func TestTrustXFF_env(t *testing.T) {
	os.Unsetenv("EVUPROXY_TRUST_XFF")
	if TrustXFF() {
		t.Fatal("expected false")
	}
	t.Setenv("EVUPROXY_TRUST_XFF", "yes")
	if !TrustXFF() {
		t.Fatal("expected true")
	}
}
