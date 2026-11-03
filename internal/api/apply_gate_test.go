package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/state"
)

const forceBody = `{"force":true}`

// validatedHash runs the check on the saved file and returns the hash it reports.
func validatedHash(t *testing.T, base string) string {
	t.Helper()
	out := wantStatus(t, doAuthed(t, http.MethodPost, base+"/api/v1/validate", ""), http.StatusOK, "")
	hash, _ := out["config_hash"].(string)
	if hash == "" {
		t.Fatalf("no config_hash: %v", out)
	}
	return hash
}

func hashBody(hash string) string { return fmt.Sprintf(`{"config_hash":%q}`, hash) }

func appendToConfig(t *testing.T, cfgPath, line string) {
	t.Helper()
	f, err := os.OpenFile(cfgPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		t.Fatal(err)
	}
}

// Nothing ran on the host and nothing was recorded as applied.
func wantNotApplied(t *testing.T, cfgPath string) {
	t.Helper()
	if h, err := state.ReadAppliedHash(cfgPath); err != nil || h != "" {
		t.Fatalf("applied hash %q, err %v: the reload went through", h, err)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(cfgPath), "generated", "apply.nft")); !os.IsNotExist(err) {
		t.Fatalf("generated apply file exists (err %v): the reload went through", err)
	}
}

func TestValidate_configHashNamesTheSavedFile(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	hash := validatedHash(t, ts.URL)
	want, err := state.ConfigFileSHA256(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if hash != want {
		t.Fatalf("config_hash %q, want the file's %q", hash, want)
	}
	if etag, _ := getConfigRevision(t, ts.URL); etag != `"`+hash+`"` {
		t.Fatalf("ETag %s is not the same revision as %s", etag, hash)
	}
	appendToConfig(t, cfgPath, "# edited")
	if got := validatedHash(t, ts.URL); got == hash {
		t.Fatal("config_hash did not change with the file")
	}
}

// A draft isn't what a reload would apply, so it must not yield something a reload accepts.
func TestValidate_draftHasNoConfigHash(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})
	_, cfg := getConfigRevision(t, ts.URL)
	renamePeer(cfg, "draft")
	body, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	out := wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/validate", string(body)), http.StatusOK, "")
	if out["validated_from_draft"] != true {
		t.Fatalf("expected a draft result: %v", out)
	}
	if _, has := out["config_hash"]; has {
		t.Fatalf("draft got a config_hash: %v", out)
	}
}

// A failed check is not something to acknowledge.
func TestValidate_failedCheckHasNoConfigHash(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && len(args) > 0 && args[0] == "-c" {
			return []byte("boom"), fmt.Errorf("exit 1")
		}
		return nil, nil
	}})
	out := wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/validate", ""), http.StatusBadRequest, "")
	if out["ok"] != false {
		t.Fatalf("expected a failed check: %v", out)
	}
	if _, has := out["config_hash"]; has {
		t.Fatalf("failed check got a config_hash: %v", out)
	}
}

func TestReload_matchingHashApplies(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	hash := validatedHash(t, ts.URL)
	out := wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", hashBody(hash)), http.StatusOK, "")
	if out["result"] != "reloaded" {
		t.Fatalf("body %v", out)
	}
	if got, err := state.ReadAppliedHash(cfgPath); err != nil || got != hash {
		t.Fatalf("applied hash %q (err %v), want %q", got, err, hash)
	}
}

// The race this gate exists for: a save lands between the check and the reload.
func TestReload_configSavedAfterCheckConflicts(t *testing.T) {
	t.Run("through the API", func(t *testing.T) {
		ts, cfgPath := newMutationTestServer(t, stubRunner{})
		hash := validatedHash(t, ts.URL)
		etag, cfg := getConfigRevision(t, ts.URL)
		renamePeer(cfg, "saved-elsewhere")
		if resp := putConfigIfMatch(t, ts.URL, cfg, etag); resp.StatusCode != http.StatusOK {
			t.Fatalf("save status %d", resp.StatusCode)
		}
		wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", hashBody(hash)), http.StatusConflict, "config_hash_mismatch")
		wantNotApplied(t, cfgPath)

		// Checking again gets the new file through.
		wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", hashBody(validatedHash(t, ts.URL))), http.StatusOK, "")
	})
	t.Run("outside the API", func(t *testing.T) {
		ts, cfgPath := newMutationTestServer(t, stubRunner{})
		hash := validatedHash(t, ts.URL)
		appendToConfig(t, cfgPath, "# edited by hand")
		wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", hashBody(hash)), http.StatusConflict, "config_hash_mismatch")
		wantNotApplied(t, cfgPath)
	})
}

func TestReload_withoutAcknowledgementConflicts(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	for _, body := range []string{"", "{}", "not json", `{"force":false}`, `{"config_hash":""}`, `{"confirm_timeout_seconds":60}`} {
		wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", body), http.StatusConflict, configHashRequiredCode)
		wantNotApplied(t, cfgPath)
	}
}

func TestReload_forceAppliesAnyConfig(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	appendToConfig(t, cfgPath, "# never checked")
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", forceBody), http.StatusOK, "")
	want, err := state.ConfigFileSHA256(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if got, err := state.ReadAppliedHash(cfgPath); err != nil || got != want {
		t.Fatalf("applied hash %q (err %v), want %q", got, err, want)
	}
}

func TestReload_forceAndHashTogetherIsInvalid(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	body := fmt.Sprintf(`{"force":true,"config_hash":%q}`, validatedHash(t, ts.URL))
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", body), http.StatusBadRequest, "invalid_reload_body")
	wantNotApplied(t, cfgPath)
}

// A forced apply is told apart from a checked one in the audit trail, and so is a refusal.
func TestReload_eventsRecordForceAndRefusal(t *testing.T) {
	_, cfgPath := newMutationTestServer(t, stubRunner{})
	el, err := eventlog.New(filepath.Dir(cfgPath), eventlog.DefaultMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{Token: "tok", Config: cfgPath, Listen: "127.0.0.1:0", EventLog: el}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", ""), http.StatusConflict, configHashRequiredCode)
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", forceBody), http.StatusOK, "")

	out := wantStatus(t, doAuthed(t, http.MethodGet, ts.URL+"/api/v1/events", ""), http.StatusOK, "")
	seen := map[string]bool{}
	events, _ := out["events"].([]any)
	for _, e := range events {
		ev := e.(map[string]any)
		detail, _ := ev["detail"].(string)
		code, _ := ev["error_code"].(string)
		seen[ev["event"].(string)+"|"+detail+"|"+code] = true
	}
	if !seen["reload_ok|reload, forced|"] {
		t.Fatalf("no forced reload_ok in %v", seen)
	}
	refused := false
	for k := range seen {
		refused = refused || (strings.HasPrefix(k, "reload_failed|") && strings.HasSuffix(k, "|"+configHashRequiredCode))
	}
	if !refused {
		t.Fatalf("no refusal in %v", seen)
	}
}

func TestReload_confirmHonoursTheGate(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, fakeSystemd())
	url := ts.URL + "/api/v1"
	post := func(body string) *http.Response { return doAuthed(t, http.MethodPost, url+"/reload", body) }
	sessionPhase := func() any {
		t.Helper()
		st := wantStatus(t, doAuthed(t, http.MethodGet, url+"/apply/session", ""), http.StatusOK, "")
		if s, ok := st["session"].(map[string]any); ok {
			return s["phase"]
		}
		return nil
	}
	wantStatus(t, post(forceBody), http.StatusOK, "") // A baseline to go back to.

	// A refused request starts no session.
	stale := validatedHash(t, ts.URL)
	appendToConfig(t, cfgPath, "# saved after the check")
	withHash := func(hash string) string {
		return fmt.Sprintf(`{"config_hash":%q,"confirm_timeout_seconds":60}`, hash)
	}
	wantStatus(t, post(withHash(stale)), http.StatusConflict, "config_hash_mismatch")
	if p := sessionPhase(); p != nil {
		t.Fatalf("mismatch started a session: %v", p)
	}

	fresh := validatedHash(t, ts.URL)
	wantStatus(t, post(withHash(fresh)), http.StatusOK, "")
	if p := sessionPhase(); p != "active" {
		t.Fatalf("session phase %v", p)
	}

	// A mismatch leaves the running session alone.
	wantStatus(t, post(withHash(stale)), http.StatusConflict, "config_hash_mismatch")
	if p := sessionPhase(); p != "active" {
		t.Fatalf("session phase after mismatch %v", p)
	}

	// force doesn't get a one-way reload past a window: the timer would undo it.
	wantStatus(t, post(forceBody), http.StatusConflict, "apply_session_active")
	wantStatus(t, post(`{"force":true,"confirm_timeout_seconds":60}`), http.StatusOK, "")
}

// A mismatch must not count against the apply metrics: nothing failed on the host.
func TestReload_mismatchIsNotARecordedFailure(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", hashBody("stale")), http.StatusConflict, "config_hash_mismatch")
	wantStatus(t, doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", ""), http.StatusConflict, configHashRequiredCode)
	if n := state.ApplyFailureTotal(cfgPath); n != 0 {
		t.Fatalf("apply failures %d after refusals", n)
	}
}
