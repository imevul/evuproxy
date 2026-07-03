package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeRunner records every command invocation and answers via handler. The
// default handler succeeds with empty output.
type fakeRunner struct {
	calls   []string
	handler func(name string, args []string) ([]byte, error)
}

func (f *fakeRunner) record(name string, args []string) {
	f.calls = append(f.calls, strings.Join(append([]string{name}, args...), " "))
}

func (f *fakeRunner) run(name string, args []string) ([]byte, error) {
	f.record(name, args)
	if f.handler != nil {
		return f.handler(name, args)
	}
	return nil, nil
}

func (f *fakeRunner) CombinedOutput(_ context.Context, name string, args ...string) ([]byte, error) {
	return f.run(name, args)
}

func (f *fakeRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	return f.run(name, args)
}

func (f *fakeRunner) OutputWithStdin(_ context.Context, _, name string, args ...string) ([]byte, error) {
	return f.run(name, args)
}

// callIndex returns the position of the first recorded call starting with prefix, or -1.
func (f *fakeRunner) callIndex(prefix string) int {
	for i, c := range f.calls {
		if strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

// withFakeReloadEnv swaps the command runner, WireGuard config dir, and interface
// probe for the duration of the test.
func withFakeReloadEnv(t *testing.T, f *fakeRunner, ifaceUp bool) {
	t.Helper()
	prevRunner := runner
	prevWGDir := wireguardConfigDir
	prevExists := wgInterfaceExists
	runner = f
	wireguardConfigDir = t.TempDir()
	wgInterfaceExists = func(string) bool { return ifaceUp }
	t.Cleanup(func() {
		runner = prevRunner
		wireguardConfigDir = prevWGDir
		wgInterfaceExists = prevExists
	})
}

// writeReloadTestConfig writes a minimal valid config (geo disabled) and the
// private key file it references; returns the config path.
func writeReloadTestConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	keyPath := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(keyPath, []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(dir, "config.yaml")
	body := fmt.Sprintf(`wireguard:
  interface: wgtest0
  listen_port: 51830
  private_key_file: %s
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes: []
peers:
  - name: a
    public_key: %s
    tunnel_ip: 10.100.0.2/32
`, keyPath, pkA)
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgPath
}

func TestReload_orderValidateBeforeLoadThenWireGuardUp(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && len(args) > 2 && args[0] == "-j" {
			return nil, fmt.Errorf("no such set") // no crowdsec set live
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfig(t)

	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v (calls %v)", err, f.calls)
	}

	check := f.callIndex("nft -c -f")
	load := f.callIndex("nft -f")
	up := f.callIndex("wg-quick up")
	if check < 0 || load < 0 || up < 0 {
		t.Fatalf("missing expected calls: %v", f.calls)
	}
	if !(check < load && load < up) {
		t.Fatalf("wrong order (validate=%d, load=%d, wg=%d): %v", check, load, up, f.calls)
	}

	// The generated ruleset must carry the atomic replace idiom for both tables.
	nft, err := os.ReadFile(filepath.Join(filepath.Dir(cfgPath), GeneratedDir, "nftables.nft"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"add table inet evuproxy\ndelete table inet evuproxy\ntable inet evuproxy {",
		"add table ip evuproxy\ndelete table ip evuproxy\ntable ip evuproxy {",
	} {
		if !strings.Contains(string(nft), want) {
			t.Fatalf("generated nftables missing %q", want)
		}
	}

	// Success must be recorded in apply state.
	if _, err := os.Stat(filepath.Join(filepath.Dir(cfgPath), ".evuproxy-last-applied.json")); err != nil {
		t.Fatalf("apply state not recorded: %v", err)
	}
}

func TestReload_validateFailureStopsBeforeLoad(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && len(args) >= 2 && args[0] == "-c" {
			return []byte("syntax error"), fmt.Errorf("exit 1")
		}
		if name == "nft" && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfig(t)

	err := Reload(context.Background(), cfgPath)
	if err == nil || !strings.Contains(err.Error(), "nft validate") {
		t.Fatalf("expected nft validate error, got %v", err)
	}
	if f.callIndex("nft -f") >= 0 {
		t.Fatalf("nft -f must not run after failed validate: %v", f.calls)
	}
	if f.callIndex("wg-quick") >= 0 || f.callIndex("wg ") >= 0 {
		t.Fatalf("wireguard must not be touched after failed validate: %v", f.calls)
	}
}

func TestReload_loadFailureSkipsWireGuard(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		if name == "nft" && args[0] == "-f" {
			return []byte("kernel rejected"), fmt.Errorf("exit 1")
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfig(t)

	err := Reload(context.Background(), cfgPath)
	if err == nil || !strings.Contains(err.Error(), "nft load") {
		t.Fatalf("expected nft load error, got %v", err)
	}
	if f.callIndex("wg-quick") >= 0 {
		t.Fatalf("wireguard must not be reloaded after failed nft load: %v", f.calls)
	}
}

func TestReload_syncconfBranchWhenInterfaceUp(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		if name == "wg-quick" && args[0] == "strip" {
			return []byte("[Interface]\nPrivateKey = x\n"), nil
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, true)
	cfgPath := writeReloadTestConfig(t)

	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v (calls %v)", err, f.calls)
	}
	if f.callIndex("wg-quick strip") < 0 {
		t.Fatalf("expected wg-quick strip: %v", f.calls)
	}
	if f.callIndex("wg syncconf wgtest0") < 0 {
		t.Fatalf("expected wg syncconf: %v", f.calls)
	}
	if f.callIndex("ip -4 addr replace 10.100.0.1/24 dev wgtest0") < 0 {
		t.Fatalf("expected tunnel address replace: %v", f.calls)
	}
	if f.callIndex("wg-quick up") >= 0 {
		t.Fatalf("wg-quick up must not run when interface exists: %v", f.calls)
	}
}

// writeReloadTestConfigGeo writes a valid config with geo enabled (country se)
// and a zone dir containing se.zone with the given content.
func writeReloadTestConfigGeo(t *testing.T, zoneContent string) string {
	t.Helper()
	cfgPath := writeReloadTestConfig(t)
	dir := filepath.Dir(cfgPath)
	zoneDir := filepath.Join(dir, "geo-zones")
	if err := os.MkdirAll(zoneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(zoneDir, "se.zone"), []byte(zoneContent), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	body := strings.Replace(string(b), "geo:\n  enabled: false\n", fmt.Sprintf(`geo:
  enabled: true
  mode: allow
  countries: [se]
  zone_dir: %s
`, zoneDir), 1)
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgPath
}

func TestReload_geoElementsInSameTransaction(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfigGeo(t, "192.0.2.0/24\n198.51.100.0/24\n")

	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v (calls %v)", err, f.calls)
	}
	apply, err := os.ReadFile(filepath.Join(filepath.Dir(cfgPath), GeneratedDir, "apply.nft"))
	if err != nil {
		t.Fatal(err)
	}
	// One file, one kernel transaction: table replace and geo set population together.
	for _, want := range []string{
		"delete table inet evuproxy",
		"add element inet evuproxy geo_v4 { 192.0.2.0/24, 198.51.100.0/24 }",
		"add element ip evuproxy geo_v4 { 192.0.2.0/24, 198.51.100.0/24 }",
	} {
		if !strings.Contains(string(apply), want) {
			t.Fatalf("apply.nft missing %q", want)
		}
	}
}

func TestReload_geoLoaderFailureAbortsBeforeKernel(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfigGeo(t, "not-an-ip\n")

	err := Reload(context.Background(), cfgPath)
	if err == nil || !strings.Contains(err.Error(), "geo loader") {
		t.Fatalf("expected geo loader error, got %v", err)
	}
	if f.callIndex("nft -f") >= 0 || f.callIndex("nft -c -f") >= 0 {
		t.Fatalf("nft must not be touched when geo loader generation fails: %v", f.calls)
	}
}

func TestReload_preservesCrowdsecBans(t *testing.T) {
	setJSON := `{"nftables":[{"metainfo":{}},{"set":{"family":"inet","table":"evuproxy","name":"crowdsec_block_v4","elem":[{"elem":{"val":"203.0.113.7","expires":120}},"198.51.100.9"]}}]}`
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && args[0] == "-j" {
			return []byte(setJSON), nil
		}
		return nil, nil
	}}
	withFakeReloadEnv(t, f, false)
	cfgPath := writeReloadTestConfig(t)
	// Snapshot/restore only runs when the config enables CrowdSec.
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, append(b, []byte("crowdsec:\n  enabled: true\n")...), 0o600); err != nil {
		t.Fatal(err)
	}

	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v (calls %v)", err, f.calls)
	}
	restore := f.callIndex("nft add element inet evuproxy crowdsec_block_v4")
	load := f.callIndex("nft -f")
	if restore < 0 {
		t.Fatalf("expected crowdsec restore call: %v", f.calls)
	}
	if restore < load {
		t.Fatalf("restore must run after table load: %v", f.calls)
	}
	call := f.calls[restore]
	if !strings.Contains(call, "203.0.113.7 timeout 120s") || !strings.Contains(call, "198.51.100.9") {
		t.Fatalf("restore payload wrong: %q", call)
	}
}
