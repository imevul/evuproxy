package main

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// Valid 44-char base64 WireGuard public keys for test fixtures.
const (
	pkA   = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	pkB   = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="
	pkNew = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC="
)

const testConfig = `wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: /etc/k
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding: {}
geo:
  enabled: false
  set_name: geo_v4
  countries: []
  zone_dir: /tmp/z
input_allows: []
peers:
  - name: alice
    public_key: ` + pkA + `
    tunnel_ip: 10.100.0.2/32
  - name: bob
    public_key: ` + pkB + `
    tunnel_ip: 10.100.0.3/32
`

func writeTestConfig(t *testing.T) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(path, []byte(testConfig), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// stubTools replaces PATH with a directory holding only the given shell scripts, so
// no test can reach the host's real wg, nft or ping, and absent tools really are absent.
func stubTools(t *testing.T, scripts map[string]string) {
	t.Helper()
	dir := t.TempDir()
	for name, body := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
}

type cliResult struct {
	stdout string
	stderr string
	err    error
}

// runCLI executes the real command tree. Commands print through both cobra's writers
// and os.Stdout/os.Stderr, so the process-wide files are swapped; tests must not be parallel.
func runCLI(t *testing.T, ctx context.Context, args ...string) cliResult {
	t.Helper()
	dir := t.TempDir()
	outPath, errPath := filepath.Join(dir, "stdout"), filepath.Join(dir, "stderr")
	outFile, err := os.Create(outPath)
	if err != nil {
		t.Fatal(err)
	}
	defer outFile.Close()
	errFile, err := os.Create(errPath)
	if err != nil {
		t.Fatal(err)
	}
	defer errFile.Close()

	prevOut, prevErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = outFile, errFile
	defer func() { os.Stdout, os.Stderr = prevOut, prevErr }()

	root := newRootCmd()
	root.SetArgs(args)
	res := cliResult{err: root.ExecuteContext(ctx)}

	outBytes, err := os.ReadFile(outPath)
	if err != nil {
		t.Fatal(err)
	}
	errBytes, err := os.ReadFile(errPath)
	if err != nil {
		t.Fatal(err)
	}
	res.stdout, res.stderr = string(outBytes), string(errBytes)
	return res
}

func run(t *testing.T, args ...string) cliResult {
	t.Helper()
	return runCLI(t, context.Background(), args...)
}

func mustRun(t *testing.T, args ...string) cliResult {
	t.Helper()
	res := run(t, args...)
	if res.err != nil {
		t.Fatalf("evuproxy %v: %v\nstderr: %s", args, res.err, res.stderr)
	}
	return res
}

func wantErrContaining(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error containing %q", want)
	}
	if !strings.Contains(err.Error(), want) {
		t.Fatalf("err = %q, want it to contain %q", err, want)
	}
}

func findPeer(t *testing.T, cfgFile, name string) *config.Peer {
	t.Helper()
	cfg, err := config.Load(cfgFile)
	if err != nil {
		t.Fatal(err)
	}
	for i := range cfg.Peers {
		if cfg.Peers[i].Name == name {
			return &cfg.Peers[i]
		}
	}
	return nil
}

func assertConfigUnchanged(t *testing.T, cfgFile string) {
	t.Helper()
	b, err := os.ReadFile(cfgFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != testConfig {
		t.Fatalf("config was modified:\n%s", b)
	}
}

func TestVersionPrintsVersion(t *testing.T) {
	res := mustRun(t, "version")
	if res.stdout != version+"\n" {
		t.Fatalf("stdout = %q", res.stdout)
	}
}

func TestRoot_commandsAreRegistered(t *testing.T) {
	root := newRootCmd()
	for _, name := range []string{
		"backup", "diagnostics", "discard-pending", "ensure-wg-networkd", "metrics",
		"peer-add", "peer-remove", "peer-set", "reload", "reload-confirm", "reload-revert",
		"reload-status", "restore", "restore-previous-applied", "serve", "status", "update-geo",
		"validate", "version",
	} {
		c, _, err := root.Find([]string{name})
		if err != nil || c == root {
			t.Errorf("command %q not registered (err %v)", name, err)
		}
	}
}

func TestRoot_unknownCommandFails(t *testing.T) {
	wantErrContaining(t, run(t, "no-such-command").err, "unknown command")
}

func TestRoot_defaultConfigPath(t *testing.T) {
	f := newRootCmd().PersistentFlags().Lookup("config")
	if f == nil || f.DefValue != "/etc/evuproxy/config.yaml" {
		t.Fatalf("config flag: %+v", f)
	}
}

func TestServe_safeDefaults(t *testing.T) {
	flags := cmdServe().Flags()
	// The API must not be reachable off-host unless the operator asks for it.
	if got := flags.Lookup("listen").DefValue; got != "127.0.0.1:9847" {
		t.Fatalf("listen default %q", got)
	}
	if got := flags.Lookup("metrics-listen").DefValue; got != "" {
		t.Fatalf("metrics-listen default %q", got)
	}
	if got := flags.Lookup("metrics-listen-insecure").DefValue; got != "false" {
		t.Fatalf("metrics-listen-insecure default %q", got)
	}
	if got := flags.Lookup("cors-origins").DefValue; got != "" {
		t.Fatalf("cors-origins default %q", got)
	}
}

func TestReloadConfirmFlow_withoutSession(t *testing.T) {
	stubTools(t, nil)
	const noSession = "no Apply is waiting for confirmation"

	t.Run("confirm fails", func(t *testing.T) {
		wantErrContaining(t, run(t, "reload-confirm", "--config", writeTestConfig(t)).err, noSession)
	})
	t.Run("manual revert fails", func(t *testing.T) {
		wantErrContaining(t, run(t, "reload-revert", "--config", writeTestConfig(t)).err, noSession)
	})
	// A confirm got there first, so a revert timer that fires afterwards must exit cleanly
	// instead of leaving a failed systemd unit behind.
	t.Run("timer revert is a no-op", func(t *testing.T) {
		cfg := writeTestConfig(t)
		mustRun(t, "reload-revert", "--config", cfg, "--token", "some-token")
		assertConfigUnchanged(t, cfg)
	})
	t.Run("status reports none as JSON", func(t *testing.T) {
		var st struct {
			ConfirmEnabled        bool            `json:"confirm_enabled"`
			ConfirmTimeoutSeconds int             `json:"confirm_timeout_seconds"`
			Session               json.RawMessage `json:"session"`
		}
		res := mustRun(t, "reload-status", "--config", writeTestConfig(t))
		if err := json.Unmarshal([]byte(res.stdout), &st); err != nil {
			t.Fatalf("stdout %q: %v", res.stdout, err)
		}
		if st.ConfirmEnabled || st.ConfirmTimeoutSeconds <= 0 || string(st.Session) != "null" {
			t.Fatalf("status: %+v", st)
		}
	})
}

func TestRefusedInvocationsLeaveConfigUntouched(t *testing.T) {
	stubTools(t, nil)
	tests := []struct {
		name string
		args []string
		want string
	}{
		{"reload with a fractional confirm window", []string{"reload", "--confirm-within", "1500ms"}, "whole seconds"},
		{"reload with boot and a confirm window", []string{"reload", "--boot", "--confirm-within", "60s"}, "none of the others"},
		{"backup without dest", []string{"backup"}, "--dest required"},
		{"restore without archive", []string{"restore"}, "--archive required"},
		{"peer-add without name", []string{"peer-add", "--public-key", pkNew}, "--name is required"},
		{"peer-add with blank name", []string{"peer-add", "--name", "  ", "--public-key", pkNew}, "--name is required"},
		{"peer-add keygen without a place for the key", []string{"peer-add", "--name", "carol"}, "--private-key-out"},
		{"peer-add duplicate name", []string{"peer-add", "--name", "alice", "--public-key", pkNew}, "already exists"},
		{"peer-add duplicate name ignores case", []string{"peer-add", "--name", " ALICE ", "--public-key", pkNew}, "already exists"},
		{"peer-add bad public key", []string{"peer-add", "--name", "carol", "--public-key", "nope", "--tunnel-ip", "10.100.0.9/32"}, ""},
		{"peer-add bad tunnel IP", []string{"peer-add", "--name", "carol", "--public-key", pkNew, "--tunnel-ip", "banana"}, ""},
		{"peer-add keygen without wg", []string{"peer-add", "--name", "carol", "--print-generated-key"}, "wg genkey"},
		{"peer-remove without selector", []string{"peer-remove"}, "at least one of"},
		{"peer-remove unknown name", []string{"peer-remove", "--name", "nobody"}, "no peer matched"},
		{"peer-remove name and key disagree", []string{"peer-remove", "--name", "alice", "--public-key", pkB}, "no peer matched"},
		{"peer-set without name", []string{"peer-set", "--new-name", "x"}, "--name is required"},
		{"peer-set unknown name", []string{"peer-set", "--name", "nobody", "--new-name", "x"}, "not found"},
		{"peer-set rename onto another peer", []string{"peer-set", "--name", "alice", "--new-name", "BOB"}, "already exists"},
		{"peer-set bad disabled value", []string{"peer-set", "--name", "alice", "--disabled", "maybe"}, "--disabled must be true or false"},
		{"peer-set bad public key", []string{"peer-set", "--name", "alice", "--public-key", "nope"}, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := writeTestConfig(t)
			res := run(t, append(tc.args, "--config", cfg)...)
			if res.err == nil {
				t.Fatalf("expected failure; stderr: %s", res.stderr)
			}
			if !strings.Contains(res.err.Error(), tc.want) {
				t.Fatalf("err = %q, want it to contain %q", res.err, tc.want)
			}
			assertConfigUnchanged(t, cfg)
		})
	}
}

func TestCommandsFailOnMissingConfig(t *testing.T) {
	stubTools(t, nil)
	for _, name := range []string{"reload", "update-geo", "status", "ensure-wg-networkd", "validate", "peer-remove"} {
		t.Run(name, func(t *testing.T) {
			args := []string{name, "--config", filepath.Join(t.TempDir(), "absent.yaml")}
			if name == "peer-remove" {
				args = append(args, "--name", "alice")
			}
			if res := run(t, args...); res.err == nil {
				t.Fatalf("expected failure; stdout: %s", res.stdout)
			}
		})
	}
}

func TestPeerAdd_explicitKeyAndTunnelIP(t *testing.T) {
	stubTools(t, nil) // wg must not be needed when the key is supplied
	cfg := writeTestConfig(t)

	res := mustRun(t, "peer-add", "--config", cfg, "--name", " carol ", "--public-key", pkNew, "--tunnel-ip", "10.100.0.50/32")

	p := findPeer(t, cfg, "carol")
	if p == nil {
		t.Fatal("peer not saved under its trimmed name")
	}
	if p.PublicKey != pkNew || p.TunnelIP != "10.100.0.50/32" {
		t.Fatalf("peer: %+v", p)
	}
	if findPeer(t, cfg, "alice") == nil || findPeer(t, cfg, "bob") == nil {
		t.Fatal("existing peers lost")
	}
	if strings.Contains(res.stderr, "assigned tunnel_ip") {
		t.Fatalf("explicit tunnel IP reported as assigned: %s", res.stderr)
	}
}

func TestPeerAdd_assignsNextFreeTunnelIP(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)

	res := mustRun(t, "peer-add", "--config", cfg, "--name", "carol", "--public-key", pkNew)

	// .1 is the server and .2/.3 are taken by the fixture peers.
	p := findPeer(t, cfg, "carol")
	if p == nil || p.TunnelIP != "10.100.0.4/32" {
		t.Fatalf("peer: %+v", p)
	}
	if !strings.Contains(res.stderr, "assigned tunnel_ip 10.100.0.4/32") {
		t.Fatalf("stderr: %s", res.stderr)
	}
}

func TestPeerAdd_nameOfDisabledPeerCanBeReused(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)
	mustRun(t, "peer-set", "--config", cfg, "--name", "alice", "--disabled", "true")

	mustRun(t, "peer-add", "--config", cfg, "--name", "alice", "--public-key", pkNew, "--tunnel-ip", "10.100.0.9/32")

	loaded, err := config.Load(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if len(loaded.Peers) != 3 {
		t.Fatalf("peers: %+v", loaded.Peers)
	}
}

// The stub only answers pubkey when the private key arrives on stdin, as with real wg.
const wgStub = `case "$1" in
genkey) echo the-private-key ;;
pubkey) read -r key; [ "$key" = the-private-key ] || exit 3; echo ` + pkNew + ` ;;
*) exit 2 ;;
esac`

func TestPeerAdd_generatedKeyGoesToFileOnly(t *testing.T) {
	stubTools(t, map[string]string{"wg": wgStub})
	cfg := writeTestConfig(t)
	keyFile := filepath.Join(t.TempDir(), "carol.key")

	res := mustRun(t, "peer-add", "--config", cfg, "--name", "carol", "--private-key-out", keyFile)

	p := findPeer(t, cfg, "carol")
	if p == nil || p.PublicKey != pkNew {
		t.Fatalf("peer: %+v", p)
	}
	b, err := os.ReadFile(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "the-private-key\n" {
		t.Fatalf("key file: %q", b)
	}
	fi, err := os.Stat(keyFile)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("key file mode %o", perm)
	}
	cfgBytes, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	for name, s := range map[string]string{"config": string(cfgBytes), "stdout": res.stdout, "stderr": res.stderr} {
		if strings.Contains(s, "the-private-key") {
			t.Fatalf("private key leaked into %s", name)
		}
	}
}

func TestPeerAdd_printGeneratedKeyUsesStderr(t *testing.T) {
	stubTools(t, map[string]string{"wg": wgStub})
	cfg := writeTestConfig(t)

	res := mustRun(t, "peer-add", "--config", cfg, "--name", "carol", "--print-generated-key")

	if !strings.Contains(res.stderr, "the-private-key") {
		t.Fatalf("stderr: %s", res.stderr)
	}
	if strings.Contains(res.stdout, "the-private-key") {
		t.Fatalf("private key on stdout: %s", res.stdout)
	}
}

func TestPeerRemove(t *testing.T) {
	stubTools(t, nil)
	tests := []struct {
		name string
		args []string
	}{
		{"by name", []string{"--name", "alice"}},
		{"by name ignoring case", []string{"--name", "ALICE"}},
		{"by public key", []string{"--public-key", pkA}},
		{"by matching name and key", []string{"--name", "alice", "--public-key", pkA}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := writeTestConfig(t)
			mustRun(t, append([]string{"peer-remove", "--config", cfg}, tc.args...)...)
			if findPeer(t, cfg, "alice") != nil {
				t.Fatal("alice still present")
			}
			if findPeer(t, cfg, "bob") == nil {
				t.Fatal("bob was removed too")
			}
		})
	}
}

func TestPeerSet_updatesFields(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)

	mustRun(t, "peer-set", "--config", cfg, "--name", "alice",
		"--new-name", "alicia", "--tunnel-ip", "10.100.0.77/32", "--public-key", pkNew)

	if findPeer(t, cfg, "alice") != nil {
		t.Fatal("old name still present")
	}
	p := findPeer(t, cfg, "alicia")
	if p == nil || p.TunnelIP != "10.100.0.77/32" || p.PublicKey != pkNew || p.Disabled {
		t.Fatalf("peer: %+v", p)
	}
	if b := findPeer(t, cfg, "bob"); b == nil || b.PublicKey != pkB || b.TunnelIP != "10.100.0.3/32" {
		t.Fatalf("bob changed: %+v", b)
	}
}

func TestPeerSet_disabledValues(t *testing.T) {
	stubTools(t, nil)
	tests := []struct {
		value string
		want  bool
	}{
		{"true", true}, {"1", true}, {"yes", true}, {" TRUE ", true},
		{"false", false}, {"0", false}, {"no", false}, {"No", false},
	}
	for _, tc := range tests {
		t.Run(tc.value, func(t *testing.T) {
			cfg := writeTestConfig(t)
			// Start from the opposite state so each value has to change something.
			start := "true"
			if tc.want {
				start = "false"
			}
			mustRun(t, "peer-set", "--config", cfg, "--name", "alice", "--disabled", start)
			mustRun(t, "peer-set", "--config", cfg, "--name", "alice", "--disabled", tc.value)
			if p := findPeer(t, cfg, "alice"); p == nil || p.Disabled != tc.want {
				t.Fatalf("peer: %+v", p)
			}
		})
	}
}

func TestPeerSet_omittedDisabledKeepsState(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)
	mustRun(t, "peer-set", "--config", cfg, "--name", "alice", "--disabled", "true")

	mustRun(t, "peer-set", "--config", cfg, "--name", "alice", "--tunnel-ip", "10.100.0.77/32")

	if p := findPeer(t, cfg, "alice"); p == nil || !p.Disabled {
		t.Fatalf("peer: %+v", p)
	}
}

// The stub rejects anything but a dry-run, so validate can never apply rules.
const nftOKStub = `[ "$1" = "-c" ] && [ "$2" = "-f" ] && [ -f "$3" ] || exit 9`

const nftFailStub = `echo "syntax error near boom" >&2; exit 1`

type validateOutput struct {
	OK     bool `json:"ok"`
	Errors []struct {
		Message string `json:"message"`
	} `json:"errors"`
	Warnings []struct {
		Code string `json:"code"`
	} `json:"warnings"`
	IPDetectionSource string `json:"ip_detection_source"`
}

func parseValidateJSON(t *testing.T, stdout string) validateOutput {
	t.Helper()
	var v validateOutput
	if err := json.Unmarshal([]byte(stdout), &v); err != nil {
		t.Fatalf("stdout %q: %v", stdout, err)
	}
	return v
}

// writeValidatableConfig also provides the private key that generating wg config reads.
func writeValidatableConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	key := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(key, []byte("the-server-key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "config.yaml")
	body := strings.Replace(testConfig, "/etc/k", key, 1)
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestValidate_validConfig(t *testing.T) {
	stubTools(t, map[string]string{"nft": nftOKStub})
	cfg := writeValidatableConfig(t)
	before, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}

	res := mustRun(t, "validate", "--config", cfg)

	if res.stdout != "" {
		t.Fatalf("stdout: %q", res.stdout)
	}
	// The CLI has no client address, so it must say the lockout check did not run.
	if !strings.Contains(res.stderr, "lockout_risk_check_unavailable") {
		t.Fatalf("stderr: %s", res.stderr)
	}
	after, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("validate changed the config:\n%s", after)
	}
	if _, err := os.Stat(state.ConfigYAMLBackupPath(cfg)); !os.IsNotExist(err) {
		t.Fatalf("validate wrote an applied snapshot: %v", err)
	}
}

func TestValidate_validConfigJSON(t *testing.T) {
	stubTools(t, map[string]string{"nft": nftOKStub})
	cfg := writeValidatableConfig(t)

	v := parseValidateJSON(t, mustRun(t, "validate", "--json", "--config", cfg).stdout)

	if !v.OK || len(v.Errors) != 0 || v.IPDetectionSource != "unavailable" {
		t.Fatalf("result: %+v", v)
	}
}

func TestValidate_nftRejection(t *testing.T) {
	stubTools(t, map[string]string{"nft": nftFailStub})
	cfg := writeValidatableConfig(t)

	res := run(t, "validate", "--config", cfg)
	wantErrContaining(t, res.err, "validation failed")
	if !strings.Contains(res.stderr, "syntax error near boom") {
		t.Fatalf("stderr: %s", res.stderr)
	}

	res = run(t, "validate", "--json", "--config", cfg)
	wantErrContaining(t, res.err, "validation failed")
	v := parseValidateJSON(t, res.stdout)
	if v.OK || len(v.Errors) != 1 || !strings.Contains(v.Errors[0].Message, "syntax error near boom") {
		t.Fatalf("result: %+v", v)
	}
}

func TestValidate_jsonReportsLoadFailureOnStdout(t *testing.T) {
	stubTools(t, nil)
	res := run(t, "validate", "--json", "--config", filepath.Join(t.TempDir(), "absent.yaml"))

	wantErrContaining(t, res.err, "validation failed")
	if v := parseValidateJSON(t, res.stdout); v.OK || len(v.Errors) != 1 {
		t.Fatalf("result: %+v", v)
	}
}

func TestDiagnostics_stdoutAndFile(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)

	res := mustRun(t, "diagnostics", "--config", cfg)
	if !strings.Contains(res.stdout, version) {
		t.Fatalf("report does not name version %s:\n%s", version, res.stdout)
	}

	out := filepath.Join(t.TempDir(), "report.md")
	res = mustRun(t, "diagnostics", "--config", cfg, "-o", out)
	if res.stdout != "" {
		t.Fatalf("stdout should be empty with -o: %q", res.stdout)
	}
	if !strings.Contains(res.stderr, "wrote "+out) {
		t.Fatalf("stderr: %s", res.stderr)
	}
	b, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), version) {
		t.Fatalf("report file:\n%s", b)
	}
	// Reports describe the host's firewall, so they stay private to the owner.
	fi, err := os.Stat(out)
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("report mode %o", perm)
	}
}

func TestDiscardPending_restoresAppliedSnapshot(t *testing.T) {
	cfg := writeTestConfig(t)
	const applied = "# applied\n" + testConfig
	if err := os.WriteFile(state.ConfigYAMLBackupPath(cfg), []byte(applied), 0o644); err != nil {
		t.Fatal(err)
	}

	mustRun(t, "discard-pending", "--config", cfg)

	b, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != applied {
		t.Fatalf("config: %s", b)
	}
}

func TestRestorePreviousApplied_withoutSnapshotFails(t *testing.T) {
	cfg := writeTestConfig(t)
	wantErrContaining(t, run(t, "restore-previous-applied", "--config", cfg).err, "no applied snapshot")
	assertConfigUnchanged(t, cfg)
}

// isolateServeEnv clears serve's environment and restores the loggers it can replace.
func isolateServeEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{"EVUPROXY_LOG_DIR", "EVUPROXY_API_TOKEN", "EVUPROXY_API_READ_TOKEN", "EVUPROXY_METRICS_LISTEN", "EVUPROXY_GEOLITE_MMDB"} {
		t.Setenv(k, "")
	}
	prevDefault, prevWriter, prevFlags := slog.Default(), log.Writer(), log.Flags()
	log.SetOutput(io.Discard) // the server's startup lines would only clutter test output
	t.Cleanup(func() {
		slog.SetDefault(prevDefault)
		log.SetOutput(prevWriter)
		log.SetFlags(prevFlags)
	})
}

// serveUntilBind runs serve with a port the listener rejects before opening a socket,
// so it exercises all of serve's startup and returns without binding anything.
func serveUntilBind(t *testing.T, extra ...string) cliResult {
	t.Helper()
	args := []string{"serve", "--config", writeTestConfig(t), "--token-file", "", "--listen", "127.0.0.1:99999"}
	return run(t, append(args, extra...)...)
}

const bindFailure = "invalid port"

func TestServe_reachesListenerWithValidSetup(t *testing.T) {
	isolateServeEnv(t)
	wantErrContaining(t, serveUntilBind(t).err, bindFailure)
}

func TestServe_missingTokenFileRefusesToStart(t *testing.T) {
	isolateServeEnv(t)
	err := serveUntilBind(t, "--token-file", filepath.Join(t.TempDir(), "absent.token")).err
	wantErrContaining(t, err, "absent.token")
}

func TestServe_namedReadTokenFileMustExist(t *testing.T) {
	isolateServeEnv(t)
	err := serveUntilBind(t, "--read-token-file", filepath.Join(t.TempDir(), "absent.token")).err
	wantErrContaining(t, err, "absent.token")
}

func TestServe_readTokenFileIsOptional(t *testing.T) {
	isolateServeEnv(t)
	dir := t.TempDir()
	present := filepath.Join(dir, "read.token")
	if err := os.WriteFile(present, []byte("r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	wantErrContaining(t, serveUntilBind(t, "--read-token-file", present).err, bindFailure)
	wantErrContaining(t, serveUntilBind(t, "--read-token-file", "").err, bindFailure)
}

func TestServe_nonLoopbackMetricsListen(t *testing.T) {
	const exposed = "0.0.0.0:99999"

	t.Run("flag is refused", func(t *testing.T) {
		isolateServeEnv(t)
		wantErrContaining(t, serveUntilBind(t, "--metrics-listen", exposed).err, "--metrics-listen-insecure")
	})
	t.Run("environment is refused", func(t *testing.T) {
		isolateServeEnv(t)
		t.Setenv("EVUPROXY_METRICS_LISTEN", exposed)
		wantErrContaining(t, serveUntilBind(t).err, "--metrics-listen-insecure")
	})
	t.Run("insecure override proceeds", func(t *testing.T) {
		isolateServeEnv(t)
		err := serveUntilBind(t, "--metrics-listen", exposed, "--metrics-listen-insecure").err
		wantErrContaining(t, err, bindFailure)
	})
}

func TestServe_unusableLogDirRefusesToStart(t *testing.T) {
	isolateServeEnv(t)
	notADir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notADir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVUPROXY_LOG_DIR", notADir)

	err := serveUntilBind(t).err
	if err == nil || strings.Contains(err.Error(), bindFailure) {
		t.Fatalf("err = %v, want a log dir failure", err)
	}
}

func TestServe_logDirReceivesServerLogs(t *testing.T) {
	isolateServeEnv(t)
	dir := filepath.Join(t.TempDir(), "logs")
	t.Setenv("EVUPROXY_LOG_DIR", dir)

	res := serveUntilBind(t)
	wantErrContaining(t, res.err, bindFailure)

	b, err := os.ReadFile(filepath.Join(dir, "evuproxy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "evuproxy API listening") {
		t.Fatalf("log file: %s", b)
	}
}

func TestServe_badGeoDatabaseWarnsAndContinues(t *testing.T) {
	isolateServeEnv(t)
	bad := filepath.Join(t.TempDir(), "GeoLite2-Country.mmdb")
	if err := os.WriteFile(bad, []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVUPROXY_GEOLITE_MMDB", bad)

	res := serveUntilBind(t)

	wantErrContaining(t, res.err, bindFailure)
	if !strings.Contains(res.stderr, "cannot open GeoIP database") || !strings.Contains(res.stderr, bad) {
		t.Fatalf("stderr: %s", res.stderr)
	}
}
