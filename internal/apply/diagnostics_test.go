package apply

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
)

func TestBuildDiagnosticsMarkdown_structureAndFailedProbe(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	const cfg = `wireguard:
  interface: wgdiag0
  listen_port: 51820
  private_key_file: /etc/evuproxy/wg-private.key
  address: 10.100.0.1/24
network:
  public_interface: eth0
peers: []
forwarding:
  routes: []
`
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	restoreDir := SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := SwapNetworkdOrNetplanInUseForTest(func() bool { return false })
	defer restoreDet()
	restoreExists := SwapWgInterfaceExistsForTest(func(string) bool { return false })
	defer restoreExists()

	restoreRunner := SwapCommandRunnerForTest(&diagStubRunner{failWG: true})
	defer restoreRunner()

	md, filename, err := BuildDiagnosticsMarkdown(context.Background(), cfgPath, DiagnosticsMeta{
		Version:     "9.9.9-test",
		GeneratedAt: time.Date(2026, 8, 11, 12, 0, 0, 0, time.UTC),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(filename, "evuproxy-diagnostics-") || !strings.HasSuffix(filename, ".md") {
		t.Fatalf("filename %q", filename)
	}
	s := string(md)
	for _, want := range []string{
		"evuproxy_version: \"9.9.9-test\"",
		"generated_utc: 2026-08-11T12:00:00Z",
		"# EvuProxy host diagnostics",
		"## Identity",
		"## References",
		"docs/config.md#wireguard-and-systemd-networkd--netplan",
		"## How to read this",
		"## Summary",
		"## Probes",
		"## Skipped / failed probes",
		"private_key_file: /etc/evuproxy/wg-private.key",
		"wg show",
	} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in report", want)
		}
	}
	if !strings.Contains(s, "wg show") || !strings.Contains(s, "Skipped / failed") {
		t.Fatal("expected failed probe section content")
	}
	// Must not embed opaque key material from a key file (we never read it).
	if strings.Contains(s, "BEGIN") && strings.Contains(s, "PRIVATE KEY") {
		t.Fatal("must not contain PEM private key material")
	}
}

func TestSanitizedConfigYAML_pathOnly(t *testing.T) {
	c := &config.Config{}
	if err := yaml.Unmarshal([]byte(`wireguard:
  interface: wg0
  listen_port: 51820
  private_key_file: /secret/key
  address: 10.0.0.1/24
network:
  public_interface: eth0
`), c); err != nil {
		t.Fatal(err)
	}
	out, err := sanitizedConfigYAML(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "/secret/key") {
		t.Fatalf("expected path preserved: %s", out)
	}
	if strings.Contains(out, "private_key:") && !strings.Contains(out, "private_key_file:") {
		t.Fatalf("unexpected private_key field: %s", out)
	}
}

func TestRedactDiagnostics_privateKeyLine(t *testing.T) {
	in := "interface: x\n  private key: SUPERSECRET\n  listening port: 1\n"
	out := redactDiagnostics(in)
	if strings.Contains(out, "SUPERSECRET") {
		t.Fatal(out)
	}
	if !strings.Contains(out, "(redacted)") {
		t.Fatal(out)
	}
}

type diagStubRunner struct {
	failWG bool
}

func (d *diagStubRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name == "wg" && d.failWG {
		return []byte("wg: Permission denied"), os.ErrPermission
	}
	if name == "docker" {
		return nil, os.ErrNotExist
	}
	if name == "uname" {
		return []byte("Linux test 6.0\n"), nil
	}
	if name == "ip" || name == "ss" || name == "sysctl" || name == "nft" || name == "systemctl" || name == "journalctl" || name == "networkctl" {
		return []byte("ok\n"), nil
	}
	return []byte("ok\n"), nil
}

func (d *diagStubRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return d.CombinedOutput(ctx, name, args...)
}

func (d *diagStubRunner) OutputWithStdin(ctx context.Context, stdin, name string, args ...string) ([]byte, error) {
	return d.CombinedOutput(ctx, name, args...)
}
