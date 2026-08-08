package apply

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func skipUnlessNFTablesCheck(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("nft not in PATH")
	}
	if err := checkNFTablesSyntax("table inet evuproxy_validate_probe {}"); err != nil {
		if strings.Contains(err.Error(), "Operation not permitted") || strings.Contains(err.Error(), "netlink") {
			t.Skip("nft -c unavailable in this environment")
		}
		t.Fatalf("nft probe: %v", err)
	}
}

func validTestConfig(t *testing.T) *config.Config {
	t.Helper()
	keyPath := filepath.Join(t.TempDir(), "wg.key")
	if err := os.WriteFile(keyPath, []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	c := testPeerConfig(config.Peer{Name: "a", PublicKey: pkA, TunnelIP: "10.100.0.2/32"})
	c.WireGuard.PrivateKeyFile = keyPath
	return c
}

func TestValidateConfig_schemaError(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Geo:       config.Geo{Enabled: false},
		Peers:     []config.Peer{{Name: "", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	res := ValidateConfig(c)
	if res.OK {
		t.Fatal("expected validation failure")
	}
	if len(res.Errors) == 0 {
		t.Fatal("expected errors")
	}
}

func TestValidateConfig_ok(t *testing.T) {
	skipUnlessNFTablesCheck(t)
	res := ValidateConfig(validTestConfig(t))
	if !res.OK {
		t.Fatalf("validate failed: %+v", res.Errors)
	}
}

func TestValidateConfigWithWarnings_includesClientIP(t *testing.T) {
	skipUnlessNFTablesCheck(t)
	c := validTestConfig(t)
	c.Forwarding.MaintenanceMode = true
	info := ClientIPInfo{IP: "203.0.113.5", Source: ClientIPSourceDirect}
	res := ValidateConfigWithWarnings(c, info, nil, true)
	if res.DetectedClientIP != "203.0.113.5" || !res.ValidatedFromDraft {
		t.Fatalf("got %+v", res)
	}
	if len(res.Warnings) == 0 || res.Warnings[0].Code != "lockout_risk_maintenance" {
		t.Fatalf("warnings %+v", res.Warnings)
	}
}

// An undetectable client address means the address-specific lockout checks did
// not run. That must not present as a clean result, or the UI shows a green
// "passed" for a config whose real risk was never evaluated.
func TestValidateConfigWithWarnings_unknownClientIPWarnsCheckSkipped(t *testing.T) {
	skipUnlessNFTablesCheck(t)
	info := ClientIPInfo{Source: ClientIPSourceUnavailable, Note: "could not determine IPv4 client address"}
	res := ValidateConfigWithWarnings(validTestConfig(t), info, nil, false)
	if !res.OK {
		t.Fatalf("validate failed: %+v", res.Errors)
	}
	found := false
	for _, w := range res.Warnings {
		if w.Code == "lockout_risk_check_unavailable" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected lockout_risk_check_unavailable, got %+v", res.Warnings)
	}
}

// The maintenance-mode risk is address-independent, so it must survive the
// address being unknown.
func TestValidateConfigWithWarnings_maintenanceWarnsWithoutClientIP(t *testing.T) {
	skipUnlessNFTablesCheck(t)
	c := validTestConfig(t)
	c.Forwarding.MaintenanceMode = true
	res := ValidateConfigWithWarnings(c, ClientIPInfo{Source: ClientIPSourceUnavailable}, nil, false)
	found := false
	for _, w := range res.Warnings {
		if w.Code == "lockout_risk_maintenance" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected lockout_risk_maintenance, got %+v", res.Warnings)
	}
}

func TestValidateConfigFile_doesNotWriteBak(t *testing.T) {
	skipUnlessNFTablesCheck(t)
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(keyPath, []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.yaml")
	body := `wireguard:
  interface: wg0
  listen_port: 51830
  private_key_file: ` + keyPath + `
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes: []
peers:
  - name: test
    public_key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
    tunnel_ip: 10.100.0.2/32
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	bakPath := path + ".bak"
	if err := os.WriteFile(bakPath, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bakBefore, err := os.ReadFile(bakPath)
	if err != nil {
		t.Fatal(err)
	}
	c, err := config.Load(path)
	if err != nil {
		t.Fatal(err)
	}
	res := ValidateConfig(c)
	if !res.OK {
		t.Fatalf("validate failed: %+v", res.Errors)
	}
	bakAfter, err := os.ReadFile(bakPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(bakAfter) != string(bakBefore) {
		t.Fatal("validate must not modify .bak")
	}
	cfgAfter, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cfgAfter), "name: test") {
		t.Fatal("config.yaml must be unchanged")
	}
}
