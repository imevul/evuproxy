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
// that has it, and rebuild.sh would leave those hosts on the old unit.
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

// update.sh runs its old copy after `git pull`, so an upgrade only gets the new unit if
// rebuild.sh --install, which starts fresh, installs it. devtools/rollback-vm runs that flow.
func TestRebuildInstall_refreshesBootUnit(t *testing.T) {
	tmpl, err := os.ReadFile(bootUnitTemplate)
	if err != nil {
		t.Fatal(err)
	}
	const edited = preBootUnit + "# local change\n"
	for name, tc := range map[string]struct {
		installed    string // "" means no unit installed
		args         []string
		otherPrefix  bool
		reloadFails  bool
		wantUpdated  bool
		wantReload   bool
		wantWarn     bool
		wantErr      bool
		wantNoBinary bool
	}{
		"old shipped unit":   {installed: preBootUnit, args: []string{"--install"}, wantUpdated: true, wantReload: true},
		"no unit":            {args: []string{"--install"}},
		"local edit":         {installed: edited, args: []string{"--install"}, wantReload: true, wantWarn: true},
		"build only":         {installed: preBootUnit, wantNoBinary: true},
		"another PREFIX":     {installed: preBootUnit, args: []string{"--install"}, otherPrefix: true, wantWarn: true},
		"reload fails stops": {installed: preBootUnit, args: []string{"--install"}, reloadFails: true, wantUpdated: true, wantReload: true, wantErr: true},
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			for _, dir := range []string{"scripts", "templates", "shims", "units", "prefix/bin", "other/bin"} {
				if err := os.MkdirAll(filepath.Join(root, dir), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			for _, script := range []string{"rebuild.sh", "update-boot-unit.sh"} {
				b, err := os.ReadFile(filepath.Join("../../scripts", script))
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "scripts", script), b, 0o755); err != nil {
					t.Fatal(err)
				}
			}
			prefix := filepath.Join(root, "prefix")
			wantUnit := strings.ReplaceAll(string(tmpl), "/usr/local/bin/evuproxy", prefix+"/bin/evuproxy")
			if err := os.WriteFile(filepath.Join(root, "templates", "evuproxy.service"), []byte(wantUnit), 0o644); err != nil {
				t.Fatal(err)
			}
			reloads := filepath.Join(root, "reloads")
			systemctl := "#!/bin/sh\necho \"$*\" >>" + reloads + "\n"
			if tc.reloadFails {
				systemctl += "exit 1\n"
			}
			for shim, body := range map[string]string{
				"id": "#!/bin/sh\necho 0\n",
				// The "new binary" accepts any config: rebuild.sh validates before installing.
				"go":        "#!/bin/sh\nwhile [ $# -gt 0 ]; do [ \"$1\" = -o ] && printf '#!/bin/sh\\nexit 0\\n' >\"$2\" && chmod +x \"$2\"; shift; done\n",
				"systemctl": systemctl,
			} {
				if err := os.WriteFile(filepath.Join(root, "shims", shim), []byte(body), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			unit := filepath.Join(root, "units", "evuproxy.service")
			if tc.installed != "" {
				if err := os.WriteFile(unit, []byte(tc.installed), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			installTo := prefix
			if tc.otherPrefix {
				installTo = filepath.Join(root, "other")
			}

			cmd := exec.Command("bash", append([]string{filepath.Join(root, "scripts", "rebuild.sh")}, tc.args...)...)
			cmd.Env = append(os.Environ(),
				"PATH="+filepath.Join(root, "shims")+string(os.PathListSeparator)+os.Getenv("PATH"),
				"PREFIX="+installTo,
				"UNIT_DIR="+filepath.Join(root, "units"),
				"CONFIG_DIR="+filepath.Join(root, "etc"),
			)
			out, err := cmd.CombinedOutput()
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v: %s", err, tc.wantErr, out)
			}
			if got := strings.Contains(string(out), "warning:"); got != tc.wantWarn {
				t.Fatalf("warning: got %v want %v: %s", got, tc.wantWarn, out)
			}
			if _, err := os.Stat(filepath.Join(installTo, "bin", "evuproxy")); (err != nil) != tc.wantNoBinary {
				t.Fatalf("installed binary: err=%v wantNoBinary=%v", err, tc.wantNoBinary)
			}
			log, err := os.ReadFile(reloads)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if want := map[bool]string{true: "daemon-reload\n"}[tc.wantReload]; string(log) != want {
				t.Fatalf("systemctl calls: got %q want %q", log, want)
			}
			if tc.installed == "" {
				if _, err := os.Stat(unit); !os.IsNotExist(err) {
					t.Fatalf("nothing should be installed (err=%v)", err)
				}
				return
			}
			got, err := os.ReadFile(unit)
			if err != nil {
				t.Fatal(err)
			}
			want := tc.installed
			if tc.wantUpdated {
				want = wantUnit
			}
			if string(got) != want {
				t.Fatalf("got %q\nwant %q", got, want)
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
