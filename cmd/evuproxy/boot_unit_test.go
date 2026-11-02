package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const (
	bootUnitTemplate = "../../templates/evuproxy.service"
	bootUnitScript   = "../../scripts/update-boot-unit.sh"
)

// The unit as shipped before --boot, which upgraded hosts still have.
const preBootUnit = `[Unit]
Description=Apply EvuProxy configuration (nftables + WireGuard)
After=network-online.target nftables.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/evuproxy reload --config /etc/evuproxy/config.yaml

[Install]
WantedBy=multi-user.target
`

func TestBootUnit_runsReloadBoot(t *testing.T) {
	b, err := os.ReadFile(bootUnitTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "ExecStart=/usr/local/bin/evuproxy reload --boot --config") {
		t.Fatalf("the boot unit must not apply unconfirmed edits:\n%s", b)
	}
}

// Without this, the next change to the template would look like a local edit on every host
// that has it, and update.sh would leave those hosts on the old unit.
func TestBootUnit_scriptKnowsCurrentTemplate(t *testing.T) {
	tmpl, err := os.ReadFile(bootUnitTemplate)
	if err != nil {
		t.Fatal(err)
	}
	script, err := os.ReadFile(bootUnitScript)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(tmpl)
	if !strings.Contains(string(script), hex.EncodeToString(h[:])) {
		t.Fatalf("add %s to SHIPPED_SHA256 in scripts/update-boot-unit.sh", hex.EncodeToString(h[:]))
	}
}

func TestBootUnit_update(t *testing.T) {
	tmpl, err := os.ReadFile(bootUnitTemplate)
	if err != nil {
		t.Fatal(err)
	}
	const edited = preBootUnit + "# local change\n"
	const editedWithBoot = "[Service]\nExecStart=/opt/evuproxy reload --boot --config /etc/evuproxy/config.yaml\n"
	const dropin = "[Service]\nExecStart=\nExecStart=/opt/evuproxy reload\n"
	const dropinWithBoot = "[Service]\nExecStart=\nExecStart=/opt/evuproxy reload --boot\n"
	for name, tc := range map[string]struct {
		installed string // "" means no unit installed
		dropin    string
		want      string
		wantWarn  bool
	}{
		"not installed":          {},
		"old shipped unit":       {installed: preBootUnit, want: string(tmpl)},
		"current unit":           {installed: string(tmpl), want: string(tmpl)},
		"local edit":             {installed: edited, want: edited, wantWarn: true},
		"local edit with --boot": {installed: editedWithBoot, want: editedWithBoot},
		"drop-in overrides":      {installed: preBootUnit, dropin: dropin, want: string(tmpl), wantWarn: true},
		"drop-in with --boot":    {installed: preBootUnit, dropin: dropinWithBoot, want: string(tmpl)},
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "evuproxy.service")
			if tc.installed != "" {
				if err := os.WriteFile(path, []byte(tc.installed), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if tc.dropin != "" {
				if err := os.Mkdir(path+".d", 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(path+".d", "override.conf"), []byte(tc.dropin), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			out, err := exec.Command("bash", bootUnitScript, bootUnitTemplate, path).CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if got := strings.Contains(string(out), "warning:"); got != tc.wantWarn {
				t.Fatalf("warning: got %v want %v: %s", got, tc.wantWarn, out)
			}
			got, err := os.ReadFile(path)
			if tc.installed == "" {
				if !os.IsNotExist(err) {
					t.Fatalf("nothing should be installed (err=%v)", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tc.want {
				t.Fatalf("got %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestReload_bootAndConfirmWithinAreExclusive(t *testing.T) {
	c := cmdReload()
	c.SetArgs([]string{"--boot", "--confirm-within", "60s"})
	c.SilenceUsage, c.SilenceErrors = true, true
	if err := c.Execute(); err == nil || !strings.Contains(err.Error(), "none of the others can be") {
		t.Fatalf("got %v", err)
	}
}
