package api

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Playwright only sees the dev config, so this keeps production's policy the same, and stops
// nginx's add_header inheritance from dropping it where a location sets a header of its own.
func TestUINginxSendsSameContentSecurityPolicy(t *testing.T) {
	policy := regexp.MustCompile(`"(default-src [^"]*)"`)
	read := func(name string) string {
		raw, err := os.ReadFile(filepath.Join("..", "..", "docker", name))
		if err != nil {
			t.Fatal(err)
		}
		return string(raw)
	}
	prod, dev := read("nginx.conf"), read("nginx.dev.conf")

	p, d := policy.FindStringSubmatch(prod), policy.FindStringSubmatch(dev)
	if p == nil || d == nil {
		t.Fatalf("missing policy: production %v, dev %v", p, d)
	}
	if got := strings.ReplaceAll(p[1], " __UI_CONNECT_SRC__", ""); got != d[1] {
		t.Errorf("policies differ:\nproduction: %s\ndev:        %s", got, d[1])
	}
	const header = "add_header Content-Security-Policy $ui_csp always;"
	if got := strings.Count(prod, header); got != 3 {
		t.Errorf("docker/nginx.conf: %q appears %d times, want 3 (server, /static/, /)", header, got)
	}
}

// The end-to-end proof that Keep fails after a cut is in devtools/rollback-vm, which CI
// doesn't run. This stops the setting it depends on from being dropped unnoticed.
func TestUINginxClosesConnectionAfterEachResponse(t *testing.T) {
	for _, name := range []string{"nginx.conf", "nginx.dev.conf"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "docker", name))
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range []string{"keepalive_timeout 0;", "client_header_timeout 5s;"} {
			if !strings.Contains(string(raw), want) {
				t.Errorf("docker/%s: missing %q", name, want)
			}
		}
	}
}
