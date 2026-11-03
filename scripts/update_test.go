package scripts

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const oldBinary = "previous binary\n"

// validConfig is minimal; %s is the WireGuard private key path.
const validConfig = `wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: %s
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes: []
peers: []
`

// Stubs stand in for everything these scripts change the host with, and log to $STUB_LOG.
// The real evuproxy runs as the "new binary", so validation itself is real apart from nft.
// devtools/e2e/scenarios/upgrade_config.sh runs this with the real nft.
//
// sudo keeps the environment, unlike the real one, so that the tests can point the scripts
// at a throwaway UNIT_DIR, CONFIG_DIR and PREFIX.
var stubs = map[string]string{
	"git": `if [ "$1" = pull ]; then echo "git pull" >>"$STUB_LOG"; else echo v0-test; fi`,
	"go": `echo "go build" >>"$STUB_LOG"
while [ $# -gt 0 ]; do
  if [ "$1" = -o ]; then cp "$REAL_EVUPROXY" "$2"; fi
  shift
done`,
	"id":   `if [ -n "${STUB_ROOT:-}" ]; then echo 0; else echo 1000; fi`,
	"sudo": `echo "sudo $1" >>"$STUB_LOG"; exec env STUB_ROOT=1 "$@"`,
	"nft": `echo "nft $1" >>"$STUB_LOG"
if [ -n "${STUB_NFT_FAIL:-}" ]; then echo "syntax error" >&2; exit 1; fi`,
	"install": `echo "install" >>"$STUB_LOG"; PATH=$STUB_REAL_PATH exec install "$@"`,
	"systemctl": `case "$1" in
  restart) echo "systemctl restart $2" >>"$STUB_LOG" ;;
  daemon-reload) echo "systemctl daemon-reload" >>"$STUB_LOG" ;;
esac`,
	"docker": `case "$*" in
  *" ps "*) echo container-id ;;
  *" config "*) echo evuproxy-ui:local ;;
  *" up "*) echo "docker up" >>"$STUB_LOG" ;;
esac`,
	"evuproxy": `echo "installed-evuproxy $1" >>"$STUB_LOG"`,
}

func buildEvuproxy(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(t.TempDir(), "evuproxy")
	out, err := exec.Command("go", "build", "-o", bin, "../cmd/evuproxy").CombinedOutput()
	if err != nil {
		t.Fatalf("go build: %v\n%s", err, out)
	}
	return bin
}

type upgradeHost struct {
	repo, prefix, configDir, log string
	env                          []string
}

// newUpgradeHost lays out a throwaway host: a clone holding the real scripts, an installed
// binary, stubbed tools and, when units is set, EvuProxy systemd units.
func newUpgradeHost(t *testing.T, realBin string, units bool) *upgradeHost {
	t.Helper()
	root := t.TempDir()
	h := &upgradeHost{
		repo:      filepath.Join(root, "repo"),
		prefix:    filepath.Join(root, "prefix"),
		configDir: filepath.Join(root, "etc"),
		log:       filepath.Join(root, "calls.log"),
	}
	unitDir := filepath.Join(root, "systemd")
	stubDir := filepath.Join(root, "stubs")
	for _, dir := range []string{filepath.Join(h.repo, "scripts"), filepath.Join(h.repo, "templates"), filepath.Join(h.prefix, "bin"), h.configDir, unitDir, stubDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	for _, script := range []string{"update.sh", "rebuild.sh", "update-boot-unit.sh"} {
		b, err := os.ReadFile(script)
		if err != nil {
			t.Fatal(err)
		}
		writeFile(t, filepath.Join(h.repo, "scripts", script), string(b), 0o755)
	}
	// rebuild.sh leaves the boot unit alone unless the template runs from PREFIX.
	writeFile(t, filepath.Join(h.repo, "templates", "evuproxy.service"), "ExecStart="+h.prefix+"/bin/evuproxy reload --boot\n", 0o644)
	writeFile(t, filepath.Join(h.repo, "docker-compose.yml"), "services: {}\n", 0o644)
	writeFile(t, filepath.Join(h.prefix, "bin", "evuproxy"), oldBinary, 0o755)
	writeFile(t, filepath.Join(h.log), "", 0o644)
	for name, body := range stubs {
		writeFile(t, filepath.Join(stubDir, name), "#!/bin/sh\n"+body+"\n", 0o755)
	}
	if units {
		writeFile(t, filepath.Join(unitDir, "evuproxy.service"), "local edit\n", 0o644)
		writeFile(t, filepath.Join(unitDir, "evuproxy-api.service"), "", 0o644)
	}
	h.env = append(os.Environ(),
		"PATH="+stubDir+string(os.PathListSeparator)+os.Getenv("PATH"),
		"STUB_REAL_PATH="+os.Getenv("PATH"),
		"STUB_LOG="+h.log,
		"REAL_EVUPROXY="+realBin,
		"PREFIX="+h.prefix,
		"CONFIG_DIR="+h.configDir,
		"UNIT_DIR="+unitDir,
	)
	return h
}

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func (h *upgradeHost) writeConfig(t *testing.T, content string) {
	t.Helper()
	writeFile(t, filepath.Join(h.configDir, "config.yaml"), content, 0o644)
}

func (h *upgradeHost) writeValidConfig(t *testing.T) {
	t.Helper()
	key := filepath.Join(h.configDir, "wg-private.key")
	writeFile(t, key, "not-a-real-key\n", 0o600)
	h.writeConfig(t, fmt.Sprintf(validConfig, key))
}

func (h *upgradeHost) run(t *testing.T, script string, args []string, extraEnv ...string) (string, error) {
	t.Helper()
	cmd := exec.Command(filepath.Join(h.repo, "scripts", script), args...)
	cmd.Env = append(h.env, extraEnv...)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	return out.String(), err
}

func (h *upgradeHost) calls(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(h.log)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func (h *upgradeHost) installedBinary(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(h.prefix, "bin", "evuproxy"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// assertStopped checks the output and that the host still has what it had.
func assertStopped(t *testing.T, h *upgradeHost, out string, err error, cause string) {
	t.Helper()
	if err == nil {
		t.Fatalf("succeeded, want failure\n%s", out)
	}
	if !strings.Contains(out, "did not pass validation") || !strings.Contains(out, "nothing was restarted") {
		t.Errorf("no clear stop message:\n%s", out)
	}
	if !strings.Contains(out, cause) {
		t.Errorf("output lacks validate's cause %q:\n%s", cause, out)
	}
	if strings.Contains(out, "Update complete") {
		t.Errorf("reported completion:\n%s", out)
	}
	if strings.Contains(out, "Usage:") {
		t.Errorf("cobra usage text buries the cause:\n%s", out)
	}
	if got := h.installedBinary(t); got != oldBinary {
		t.Error("installed binary was replaced")
	}
	calls := h.calls(t)
	if !strings.Contains(calls, "go build") {
		t.Errorf("never built, so the new binary did not run:\n%s", calls)
	}
	for _, forbidden := range []string{"install", "systemctl", "docker up"} {
		if strings.Contains(calls, forbidden) {
			t.Errorf("%q ran before the stop:\n%s", forbidden, calls)
		}
	}
}

func TestUpdateStopsOnRejectedConfig(t *testing.T) {
	realBin := buildEvuproxy(t)
	cases := []struct {
		name  string
		setup func(t *testing.T, h *upgradeHost)
		env   []string
		cause string
	}{
		{
			name:  "rejected by validation",
			setup: func(t *testing.T, h *upgradeHost) { h.writeConfig(t, "wireguard:\n  listen_port: 0\n") },
			cause: "wireguard",
		},
		{
			name:  "unparseable yaml",
			setup: func(t *testing.T, h *upgradeHost) { h.writeConfig(t, "wireguard: [\n") },
			cause: "yaml",
		},
		{
			name: "private key missing",
			setup: func(t *testing.T, h *upgradeHost) {
				h.writeValidConfig(t)
				if err := os.Remove(filepath.Join(h.configDir, "wg-private.key")); err != nil {
					t.Fatal(err)
				}
			},
			cause: "private key",
		},
		{
			name:  "generated rules rejected by nft",
			setup: func(t *testing.T, h *upgradeHost) { h.writeValidConfig(t) },
			env:   []string{"STUB_NFT_FAIL=1"},
			cause: "syntax error",
		},
		{
			name:  "units but no config",
			setup: func(*testing.T, *upgradeHost) {},
			cause: "config.yaml",
		},
	}
	for _, tc := range cases {
		for _, who := range []string{"through sudo", "as root"} {
			t.Run(tc.name+" "+who, func(t *testing.T) {
				h := newUpgradeHost(t, realBin, true)
				tc.setup(t, h)
				env := tc.env
				if who == "as root" {
					env = append(env[:len(env):len(env)], "STUB_ROOT=1")
				}
				out, err := h.run(t, "update.sh", nil, env...)
				assertStopped(t, h, out, err, tc.cause)
			})
		}
	}
}

func TestUpdateValidatesBeforeInstallAndRestart(t *testing.T) {
	realBin := buildEvuproxy(t)
	want, err := os.ReadFile(realBin)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		env  []string
	}{
		{name: "through sudo"},
		{name: "as root", env: []string{"STUB_ROOT=1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := newUpgradeHost(t, realBin, true)
			h.writeValidConfig(t)

			out, err := h.run(t, "update.sh", nil, tc.env...)
			if err != nil {
				t.Fatalf("update.sh: %v\n%s", err, out)
			}
			if !strings.Contains(out, "Update complete") {
				t.Errorf("no completion message:\n%s", out)
			}
			if got := h.installedBinary(t); got != string(want) {
				t.Error("new binary was not installed")
			}
			calls := h.calls(t)
			last := -1
			for _, step := range []string{"git pull", "go build", "nft -c", "install", "systemctl daemon-reload", "systemctl restart evuproxy.service", "systemctl restart evuproxy-api.service", "docker up"} {
				i := strings.Index(calls, step)
				if i < 0 {
					t.Fatalf("%q did not run:\n%s", step, calls)
				}
				if i < last {
					t.Fatalf("%q ran out of order:\n%s", step, calls)
				}
				last = i
			}
		})
	}
}

// Without units update.sh doesn't install the binary, so the version running here stays
// what it was and there is nothing for a bad config to break.
func TestUpdateWithoutUnitsDoesNotValidate(t *testing.T) {
	h := newUpgradeHost(t, buildEvuproxy(t), false)
	h.writeConfig(t, "wireguard: [\n")

	out, err := h.run(t, "update.sh", nil)
	if err != nil {
		t.Fatalf("update.sh: %v\n%s", err, out)
	}
	if strings.Contains(out, "Validating") {
		t.Errorf("validated without installing:\n%s", out)
	}
	if got := h.installedBinary(t); got != oldBinary {
		t.Error("installed a binary on a host without units")
	}
}

func TestRebuildInstallValidates(t *testing.T) {
	realBin := buildEvuproxy(t)
	install := []string{"--install"}

	t.Run("bad config without units still stops an install", func(t *testing.T) {
		h := newUpgradeHost(t, realBin, false)
		h.writeConfig(t, "wireguard: [\n")
		out, err := h.run(t, "rebuild.sh", install, "STUB_ROOT=1")
		assertStopped(t, h, out, err, "yaml")
	})

	t.Run("nothing to validate on a host with no config or units", func(t *testing.T) {
		h := newUpgradeHost(t, realBin, false)
		out, err := h.run(t, "rebuild.sh", install, "STUB_ROOT=1")
		if err != nil {
			t.Fatalf("rebuild.sh --install: %v\n%s", err, out)
		}
		if strings.Contains(out, "Validating") {
			t.Errorf("validated a config that does not exist:\n%s", out)
		}
		if h.installedBinary(t) == oldBinary {
			t.Error("new binary was not installed")
		}
	})

	t.Run("a plain build does not validate", func(t *testing.T) {
		h := newUpgradeHost(t, realBin, true)
		h.writeConfig(t, "wireguard: [\n")
		if out, err := h.run(t, "rebuild.sh", nil); err != nil {
			t.Fatalf("rebuild.sh: %v\n%s", err, out)
		}
	})
}
