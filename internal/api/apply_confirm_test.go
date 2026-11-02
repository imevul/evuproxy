package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
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

func TestReloadBody_plainAndIgnoredBodiesStayOneWay(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, fakeSystemd())
	// Bodies used to be ignored, so these must keep meaning a plain reload.
	for _, body := range []string{"", "{}", "not json", `{"confirm_timeout_seconds":0}`} {
		out := wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", body), http.StatusOK, "")
		if _, has := out["session"]; has {
			t.Fatalf("body %q started a session: %v", body, out)
		}
	}
	if _, err := os.Stat(cfgPath + ".bak"); err != nil {
		t.Fatal(err)
	}
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
	const confirmBody = `{"confirm_timeout_seconds":60}`

	// A fresh install has never applied: nothing to go back to.
	wantStatus(t, post("/reload", confirmBody), http.StatusConflict, "no_baseline")
	wantStatus(t, post("/reload", ""), http.StatusOK, "")

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
	wantStatus(t, post("/reload", ""), http.StatusConflict, "apply_session_active")
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
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", ""), http.StatusOK, "")
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", `{"confirm_timeout_seconds":60}`), http.StatusConflict, "confirm_unavailable")
}
