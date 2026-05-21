package observability

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
)

func TestPrometheusText_containsMetrics(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	body := `wireguard:
  interface: wg0
  listen_port: 51830
  private_key_file: ` + filepath.Join(dir, "wg.key") + `
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes: []
peers: []
`
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wg.key"), []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	_ = apply.RecordApplySuccess(cfgPath)
	out, err := PrometheusText(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, needle := range []string{
		"# HELP evuproxy_apply_success_total",
		"# TYPE evuproxy_peers_online gauge",
		"evuproxy_maintenance_mode",
	} {
		if !strings.Contains(s, needle) {
			t.Fatalf("missing %q in:\n%s", needle, s)
		}
	}
}

func TestValidateMetricsListen_loopback(t *testing.T) {
	if err := ValidateMetricsListen("127.0.0.1:9848"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMetricsListen("0.0.0.0:9848"); err == nil {
		t.Fatal("expected error for non-loopback")
	}
	if err := ValidateMetricsListen("[::1]:9848"); err != nil {
		t.Fatal(err)
	}
}
