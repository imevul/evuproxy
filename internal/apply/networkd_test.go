package apply

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestEnsureWireGuardUnmanaged_skipWithoutNetworkd(t *testing.T) {
	dir := t.TempDir()
	restoreDir := SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := SwapNetworkdOrNetplanInUseForTest(func() bool { return false })
	defer restoreDet()

	path, wrote, err := EnsureWireGuardUnmanaged("evuproxy0")
	if err != nil {
		t.Fatal(err)
	}
	if path != "" || wrote {
		t.Fatalf("expected skip, got path=%q wrote=%v", path, wrote)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 0 {
		t.Fatalf("expected no files, got %v", entries)
	}
}

func TestEnsureWireGuardUnmanaged_writesDropIn(t *testing.T) {
	dir := t.TempDir()
	restoreDir := SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := SwapNetworkdOrNetplanInUseForTest(func() bool { return true })
	defer restoreDet()

	// Legacy 80- file must be removed so 00- can take effect.
	legacy := filepath.Join(dir, "80-evuproxy0.network")
	if err := os.WriteFile(legacy, []byte("stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	path, wrote, err := EnsureWireGuardUnmanaged("evuproxy0")
	if err != nil {
		t.Fatal(err)
	}
	if !wrote {
		t.Fatal("expected write")
	}
	want := filepath.Join(dir, "00-evuproxy0.network")
	if path != want {
		t.Fatalf("path %q want %q", path, want)
	}
	if _, err := os.Stat(legacy); !os.IsNotExist(err) {
		t.Fatalf("legacy 80- drop-in should be removed: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "Name=evuproxy0") || !strings.Contains(string(body), "Unmanaged=yes") {
		t.Fatalf("body: %s", body)
	}

	path2, wrote2, err := EnsureWireGuardUnmanaged("evuproxy0")
	if err != nil {
		t.Fatal(err)
	}
	if wrote2 || path2 != want {
		t.Fatalf("idempotent: wrote=%v path=%q", wrote2, path2)
	}
}

func TestWireGuardHostWarnings_missingAddrAndEPrefix(t *testing.T) {
	dir := t.TempDir()
	restoreDir := SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := SwapNetworkdOrNetplanInUseForTest(func() bool { return true })
	defer restoreDet()
	restoreExists := SwapWgInterfaceExistsForTest(func(string) bool { return true })
	defer restoreExists()

	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "evuproxy0", Address: "10.100.0.1/24"},
	}

	// Stub ip addr show: no address on iface.
	restoreRunner := SwapCommandRunnerForTest(&stubIPAddrRunner{out: "3: evuproxy0    inet 127.0.0.1/8 scope host\n"})
	defer restoreRunner()

	ws := WireGuardHostWarnings(context.Background(), c, "")
	codes := map[string]bool{}
	for _, w := range ws {
		codes[w.Code] = true
	}
	if !codes["wg_iface_netplan_e_prefix_risk"] {
		t.Fatalf("expected e-prefix risk when drop-in missing: %+v", ws)
	}
	if !codes["wg_tunnel_address_missing"] {
		t.Fatalf("expected missing tunnel addr: %+v", ws)
	}

	// After drop-in exists, e-prefix risk should clear; missing addr remains.
	if _, _, err := EnsureWireGuardUnmanaged("evuproxy0"); err != nil {
		t.Fatal(err)
	}
	ws = WireGuardHostWarnings(context.Background(), c, "")
	codes = map[string]bool{}
	for _, w := range ws {
		codes[w.Code] = true
	}
	if codes["wg_iface_netplan_e_prefix_risk"] {
		t.Fatalf("e-prefix risk should clear with drop-in: %+v", ws)
	}
	if !codes["wg_tunnel_address_missing"] {
		t.Fatalf("missing addr should remain: %+v", ws)
	}
}

type stubIPAddrRunner struct {
	out string
}

func (s *stubIPAddrRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	if name == "ip" {
		return []byte(s.out), nil
	}
	return nil, os.ErrNotExist
}

func (s *stubIPAddrRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return s.CombinedOutput(ctx, name, args...)
}

func (s *stubIPAddrRunner) OutputWithStdin(ctx context.Context, stdin, name string, args ...string) ([]byte, error) {
	return s.CombinedOutput(ctx, name, args...)
}
