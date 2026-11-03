package autopause

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/state"
)

const loadConfigYAML = `
wireguard:
  interface: wg0
  listen_port: 51820
  private_key_file: /key
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes: []
geo:
  enabled: false
input_allows: []
peers: []
`

func TestLoadConfig_prefersAppliedSnapshot(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	pending := strings.Replace(loadConfigYAML, "wg0", "wg-pending", 1)
	if err := os.WriteFile(cfgPath, []byte(pending), 0o600); err != nil {
		t.Fatal(err)
	}

	c, err := LoadConfig(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if c.WireGuard.Interface != "wg-pending" {
		t.Fatalf("no snapshot yet: interface = %q, want config.yaml's", c.WireGuard.Interface)
	}

	if err := os.WriteFile(state.ConfigYAMLBackupPath(cfgPath), []byte(loadConfigYAML), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err = LoadConfig(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if c.WireGuard.Interface != "wg0" {
		t.Fatalf("with snapshot: interface = %q, want the applied one", c.WireGuard.Interface)
	}

	// A snapshot that no longer loads falls back rather than stopping the loop.
	if err := os.WriteFile(state.ConfigYAMLBackupPath(cfgPath), []byte("not: [valid"), 0o600); err != nil {
		t.Fatal(err)
	}
	c, err = LoadConfig(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if c.WireGuard.Interface != "wg-pending" {
		t.Fatalf("unusable snapshot: interface = %q, want config.yaml's", c.WireGuard.Interface)
	}
}
