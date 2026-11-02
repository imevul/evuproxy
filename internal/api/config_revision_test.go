package api

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/state"
)

func TestPending_appliedConfig(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfigPort(t, cfgPath, 51829)
	s := &Server{Token: "tok", Config: cfgPath, Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	pending := func() map[string]any {
		t.Helper()
		resp := doAuthed(t, http.MethodGet, ts.URL+"/api/v1/pending", "")
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET /pending status %d", resp.StatusCode)
		}
		return decodeJSONMap(t, resp)
	}

	// The key is present and null, so the UI can tell this from an API older than the field.
	got, present := pending()["applied_config"]
	if !present || got != nil {
		t.Fatalf("applied_config = %v (present %v), want null before any apply", got, present)
	}

	if err := state.RecordAppliedConfigHash(cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := state.RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	writeMinimalConfigPort(t, cfgPath, 51830)

	m := pending()
	if m["pending"] != true {
		t.Fatal("expected pending after saving over the applied config")
	}
	applied, ok := m["applied_config"].(map[string]any)
	if !ok {
		t.Fatalf("applied_config = %v, want an object", m["applied_config"])
	}
	// Same field names as GET /config, which holds the saved side of the comparison.
	_, cfg := getConfigRevision(t, ts.URL)
	if port := cfg["wireguard"].(map[string]any)["listen_port"]; port != float64(51830) {
		t.Fatalf("GET /config listen_port = %v, want the saved 51830", port)
	}
	if port := applied["wireguard"].(map[string]any)["listen_port"]; port != float64(51829) {
		t.Fatalf("applied_config listen_port = %v, want the applied 51829", port)
	}
}

func getConfigRevision(t *testing.T, base string) (etag string, cfg map[string]any) {
	t.Helper()
	resp := doAuthed(t, http.MethodGet, base+"/api/v1/config", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /config status %d", resp.StatusCode)
	}
	etag = resp.Header.Get("ETag")
	if len(etag) < 3 || !strings.HasPrefix(etag, `"`) || !strings.HasSuffix(etag, `"`) {
		t.Fatalf("ETag %q is not a quoted revision", etag)
	}
	return etag, decodeJSONMap(t, resp)
}

func putConfigIfMatch(t *testing.T, base string, cfg map[string]any, ifMatch ...string) *http.Response {
	t.Helper()
	b, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, base+"/api/v1/config", strings.NewReader(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer tok")
	for _, v := range ifMatch {
		req.Header.Add("If-Match", v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func renamePeer(cfg map[string]any, name string) {
	cfg["peers"].([]any)[0].(map[string]any)["name"] = name
}

func peerNameOnDisk(t *testing.T, base string) string {
	t.Helper()
	_, cfg := getConfigRevision(t, base)
	return cfg["peers"].([]any)[0].(map[string]any)["name"].(string)
}

func TestConfigPut_ifMatchCurrentRevisionSaves(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})
	etag, cfg := getConfigRevision(t, ts.URL)

	renamePeer(cfg, "renamed")
	resp := putConfigIfMatch(t, ts.URL, cfg, etag)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	newTag := resp.Header.Get("ETag")
	if newTag == "" || newTag == etag {
		t.Fatalf("PUT ETag %q should be a new revision (was %q)", newTag, etag)
	}
	if got, _ := getConfigRevision(t, ts.URL); got != newTag {
		t.Fatalf("GET ETag %q differs from PUT ETag %q", got, newTag)
	}
	if got := peerNameOnDisk(t, ts.URL); got != "renamed" {
		t.Fatalf("peer name %q", got)
	}
}

// The lost-update case: a stale tab must not overwrite a change saved elsewhere.
func TestConfigPut_staleRevisionConflicts(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})
	staleTag, staleCfg := getConfigRevision(t, ts.URL)

	_, otherCfg := getConfigRevision(t, ts.URL)
	renamePeer(otherCfg, "saved-elsewhere")
	if resp := putConfigIfMatch(t, ts.URL, otherCfg, staleTag); resp.StatusCode != http.StatusOK {
		t.Fatalf("first save status %d", resp.StatusCode)
	}

	resp := putConfigIfMatch(t, ts.URL, staleCfg, staleTag)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale save status %d, want 409", resp.StatusCode)
	}
	if code := decodeJSONMap(t, resp)["error_code"]; code != configRevisionMismatchCode {
		t.Fatalf("error_code %v", code)
	}
	if got := peerNameOnDisk(t, ts.URL); got != "saved-elsewhere" {
		t.Fatalf("stale save overwrote the file: peer name %q", got)
	}
}

// Revisions hash the file, so edits that bypass PUT (CLI, hand edits) also conflict.
func TestConfigPut_fileEditedOutsideAPIConflicts(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	etag, cfg := getConfigRevision(t, ts.URL)

	f, err := os.OpenFile(cfgPath, os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("# edited by hand\n"); err != nil {
		t.Fatal(err)
	}
	f.Close()

	if resp := putConfigIfMatch(t, ts.URL, cfg, etag); resp.StatusCode != http.StatusConflict {
		t.Fatalf("status %d, want 409", resp.StatusCode)
	}
}

func TestConfigPut_conflictReportedBeforeValidation(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})
	_, cfg := getConfigRevision(t, ts.URL)
	cfg["peers"].([]any)[0].(map[string]any)["public_key"] = "not-a-key"

	if resp := putConfigIfMatch(t, ts.URL, cfg, `"stale"`); resp.StatusCode != http.StatusConflict {
		t.Fatalf("status %d, want 409", resp.StatusCode)
	}
}

// Clients that send no If-Match (CLI wrappers, automation) keep last-write-wins.
func TestConfigPut_missingIfMatchIsUnconditional(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})
	_, staleCfg := getConfigRevision(t, ts.URL)
	etag, cfg := getConfigRevision(t, ts.URL)
	renamePeer(cfg, "saved-elsewhere")
	if resp := putConfigIfMatch(t, ts.URL, cfg, etag); resp.StatusCode != http.StatusOK {
		t.Fatalf("first save status %d", resp.StatusCode)
	}

	renamePeer(staleCfg, "automation")
	resp := putConfigIfMatch(t, ts.URL, staleCfg)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if resp.Header.Get("ETag") == "" {
		t.Fatal("unconditional PUT should still report the new revision")
	}
	if got := peerNameOnDisk(t, ts.URL); got != "automation" {
		t.Fatalf("peer name %q", got)
	}
}

func TestParseIfMatch(t *testing.T) {
	cases := []struct {
		name   string
		values []string
		want   []string
	}{
		{"missing", nil, nil},
		{"wildcard", []string{"*"}, nil},
		{"quoted", []string{`"abc"`}, []string{"abc"}},
		{"weak", []string{`W/"abc"`}, []string{"abc"}},
		{"unquoted", []string{"abc"}, []string{"abc"}},
		{"list", []string{`"a", "b"`, `"c"`}, []string{"a", "b", "c"}},
		{"empty fails closed", []string{""}, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := http.Header{}
			for _, v := range c.values {
				h.Add("If-Match", v)
			}
			got := parseIfMatch(h)
			if (got == nil) != (c.want == nil) || strings.Join(got, "|") != strings.Join(c.want, "|") {
				t.Fatalf("got %#v, want %#v", got, c.want)
			}
		})
	}
}

func TestCORS_allowsIfMatchAndExposesETag(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	s := &Server{Token: "tok", Config: cfgPath, Listen: "127.0.0.1:0", CORSOrigins: "https://ui.example"}
	ts := httptest.NewServer(testHandler(s))
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/v1/config", nil)
	req.Header.Set("Origin", "https://ui.example")
	req.Header.Set("Access-Control-Request-Method", "PUT")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if got := resp.Header.Get("Access-Control-Allow-Headers"); !strings.Contains(got, "If-Match") {
		t.Fatalf("allow-headers %q", got)
	}
	if got := resp.Header.Get("Access-Control-Expose-Headers"); !strings.Contains(got, "ETag") {
		t.Fatalf("expose-headers %q", got)
	}
}
