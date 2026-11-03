package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
)

// fakeSystemd is a stubRunner where armed timers stay active until stopped.
func fakeSystemd() stubRunner {
	timers := map[string]bool{}
	return stubRunner{handler: func(name string, args []string) ([]byte, error) {
		switch name {
		case "systemd-run":
			for _, a := range args {
				if unit, ok := strings.CutPrefix(a, "--unit="); ok {
					timers[unit+".timer"] = true
				}
			}
		case "systemctl":
			unit := args[len(args)-1]
			if args[0] == "stop" {
				delete(timers, unit)
			}
			if args[0] == "is-active" {
				if timers[unit] {
					return []byte("active\n"), nil
				}
				return []byte("inactive\n"), errors.New("exit 3")
			}
		}
		return nil, nil
	}}
}

func readJSON(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("%q: %v", b, err)
	}
	return out
}

func wantStatus(t *testing.T, resp *http.Response, status int, code string) map[string]any {
	t.Helper()
	out := readJSON(t, resp)
	if resp.StatusCode != status {
		t.Fatalf("status %d, want %d: %v", resp.StatusCode, status, out)
	}
	if code != "" && out["error_code"] != code {
		t.Fatalf("error_code %v, want %s: %v", out["error_code"], code, out)
	}
	return out
}

func TestReloadBody_withoutTimeoutStaysOneWay(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, fakeSystemd())
	for _, body := range []string{forceBody, `{"force":true,"confirm_timeout_seconds":0}`} {
		out := wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", body), http.StatusOK, "")
		if _, has := out["session"]; has {
			t.Fatalf("body %q started a session: %v", body, out)
		}
	}
	if _, err := os.Stat(cfgPath + ".bak"); err != nil {
		t.Fatal(err)
	}
}

func TestUpdateGeo_holdsBackUnappliedCountries(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, fakeSystemd())
	t.Cleanup(apply.SwapGeoZoneDownloadForTest(func(context.Context, *config.Config) error { return nil }))
	url := ts.URL + "/api/v1"
	zoneDir := t.TempDir()
	for _, cc := range []string{"se", "no"} {
		if err := os.WriteFile(filepath.Join(zoneDir, cc+".zone"), []byte("192.0.2.0/24\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	geo := "geo:\n  enabled: true\n  countries: [se]\n  zone_dir: " + zoneDir + "\n"
	applied := strings.Replace(string(b), "geo:\n  enabled: false\n", geo, 1) + "apply:\n  confirm: true\n"
	if err := os.WriteFile(cfgPath, []byte(applied), 0o644); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, doAuthed(t, http.MethodPost, url+"/reload", forceBody), http.StatusOK, "")

	updateGeo := func(status int, code string) map[string]any {
		t.Helper()
		return wantStatus(t, doAuthed(t, http.MethodPost, url+"/update-geo", ""), status, code)
	}
	if out := updateGeo(http.StatusOK, ""); out["result"] != "geo_updated" || out["geo_changes_held_back"] != false {
		t.Fatalf("nothing pending: %v", out)
	}
	edited := strings.Replace(applied, "countries: [se]", "countries: [no]", 1)
	if err := os.WriteFile(cfgPath, []byte(edited), 0o644); err != nil {
		t.Fatal(err)
	}
	if out := updateGeo(http.StatusOK, ""); out["result"] != "geo_updated" || out["geo_changes_held_back"] != true {
		t.Fatalf("countries pending: %v", out)
	}
	wantStatus(t, doAuthed(t, http.MethodPost, url+"/reload", `{"force":true,"confirm_timeout_seconds":60}`), http.StatusOK, "")
	updateGeo(http.StatusConflict, "apply_session_active")
}

func TestReloadBody_invalid(t *testing.T) {
	ts, _ := newMutationTestServer(t, fakeSystemd())
	for _, body := range []string{`{"confirm_timeout_seconds":"60"}`, `{"confirm_timeout_seconds":5}`, `{"confirm_timeout_seconds":99999}`, `{broken`} {
		wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", body), http.StatusBadRequest, "invalid_reload_body")
	}
}

func TestApplySessionFlow(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, fakeSystemd())
	url := ts.URL + "/api/v1"
	post := func(path, body string) *http.Response { return doAuthed(t, http.MethodPost, url+path, body) }
	const confirmBody = `{"force":true,"confirm_timeout_seconds":60}`

	// A fresh install has never applied: nothing to go back to.
	wantStatus(t, post("/reload", confirmBody), http.StatusConflict, "no_baseline")
	wantStatus(t, post("/reload", forceBody), http.StatusOK, "")

	st := wantStatus(t, doAuthed(t, http.MethodGet, url+"/apply/session", ""), http.StatusOK, "")
	if st["session"] != nil || st["confirm_enabled"] != false {
		t.Fatalf("status: %v", st)
	}
	wantStatus(t, post("/apply/confirm", ""), http.StatusConflict, "no_apply_session")
	wantStatus(t, post("/apply/revert", ""), http.StatusConflict, "no_apply_session")

	// Confirm.
	out := wantStatus(t, post("/reload", confirmBody), http.StatusOK, "")
	session, _ := out["session"].(map[string]any)
	if session == nil || session["phase"] != "active" {
		t.Fatalf("reload: %v", out)
	}
	if _, leaked := session["token"]; leaked {
		t.Fatal("the timer token stays on the host")
	}
	wantStatus(t, post("/reload", forceBody), http.StatusConflict, "apply_session_active")
	wantStatus(t, post("/restore?path=/var/backups/x.tgz", ""), http.StatusConflict, "apply_session_active")
	wantStatus(t, post("/reload", confirmBody), http.StatusOK, "")
	wantStatus(t, post("/apply/confirm", ""), http.StatusOK, "")
	st = wantStatus(t, doAuthed(t, http.MethodGet, url+"/apply/session", ""), http.StatusOK, "")
	if st["session"] != nil {
		t.Fatalf("status: %v", st)
	}

	// Revert, then bring the rejected config back as unapplied changes.
	base, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	rejected := append(append([]byte{}, base...), []byte("# rejected\n")...)
	if err := os.WriteFile(cfgPath, rejected, 0o644); err != nil {
		t.Fatal(err)
	}
	wantStatus(t, post("/reload", confirmBody), http.StatusOK, "")
	wantStatus(t, post("/apply/revert", ""), http.StatusOK, "")
	if got, _ := os.ReadFile(cfgPath); string(got) != string(base) {
		t.Fatalf("config not reverted: %q", got)
	}
	st = wantStatus(t, doAuthed(t, http.MethodGet, url+"/apply/session", ""), http.StatusOK, "")
	lr, _ := st["last_revert"].(map[string]any)
	if lr == nil || lr["reason"] != "manual" || lr["config_available"] != true {
		t.Fatalf("last_revert: %v", st)
	}
	wantStatus(t, post("/apply/reverted/restore", ""), http.StatusOK, "")
	if got, _ := os.ReadFile(cfgPath); string(got) != string(rejected) {
		t.Fatalf("config not restored: %q", got)
	}
	wantStatus(t, post("/apply/reverted/restore", ""), http.StatusConflict, "no_reverted_config")
	wantStatus(t, post("/apply/reverted/dismiss", ""), http.StatusOK, "")
}

func TestConfirmUnavailable_onHostsWithoutSystemd(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{handler: func(name string, _ []string) ([]byte, error) {
		if name == "systemd-run" {
			return []byte("not found"), errors.New("exit 127")
		}
		return nil, nil
	}})
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", forceBody), http.StatusOK, "")
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", `{"force":true,"confirm_timeout_seconds":60}`), http.StatusConflict, "confirm_unavailable")
}
