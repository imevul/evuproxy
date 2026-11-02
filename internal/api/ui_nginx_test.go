package api

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
