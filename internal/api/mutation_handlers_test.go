package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
)

// stubRunner answers all subprocess invocations via handler (default: success,
// empty output) so mutation handlers can run without nft/wg/tar installed.
type stubRunner struct {
	handler func(name string, args []string) ([]byte, error)
}

func (s stubRunner) call(name string, args []string) ([]byte, error) {
	if s.handler != nil {
		return s.handler(name, args)
	}
	return nil, nil
}

func (s stubRunner) CombinedOutput(_ context.Context, name string, args ...string) ([]byte, error) {
	return s.call(name, args)
}

func (s stubRunner) Output(_ context.Context, name string, args ...string) ([]byte, error) {
	return s.call(name, args)
}

func (s stubRunner) OutputWithStdin(_ context.Context, _, name string, args ...string) ([]byte, error) {
	return s.call(name, args)
}

// newMutationTestServer stubs subprocess execution and WireGuard config writes,
// writes a valid config (with an existing private key file), and returns a
// running test server plus the config path.
func newMutationTestServer(t *testing.T, run stubRunner) (*httptest.Server, string) {
	t.Helper()
	t.Cleanup(apply.SwapCommandRunnerForTest(run))
	t.Cleanup(apply.SwapWireGuardConfigDirForTest(t.TempDir()))

	dir := t.TempDir()
	keyPath := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(keyPath, []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfgPath := filepath.Join(dir, "config.yaml")
	body := fmt.Sprintf(`wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: %s
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes:
    - proto: tcp
      ports: ["80"]
      target_ip: 10.100.0.2
peers:
  - name: p1
    public_key: aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=
    tunnel_ip: 10.100.0.2/32
`, keyPath)
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	s := &Server{Token: "tok", Config: cfgPath, Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	return ts, cfgPath
}

func doAuthed(t *testing.T, method, url string, body string) *http.Response {
	t.Helper()
	var rd *strings.Reader
	if body == "" {
		rd = strings.NewReader("")
	} else {
		rd = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, url, rd)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer tok")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

func decodeJSONMap(t *testing.T, resp *http.Response) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestHandleReload_success(t *testing.T) {
	run := stubRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && len(args) > 0 && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		return nil, nil
	}}
	ts, _ := newMutationTestServer(t, run)

	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if m := decodeJSONMap(t, resp); m["result"] != "reloaded" {
		t.Fatalf("body %v", m)
	}
}

func TestHandleReload_nftFailureIs500(t *testing.T) {
	run := stubRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "nft" && len(args) > 0 && args[0] == "-j" {
			return nil, fmt.Errorf("no such set")
		}
		if name == "nft" && len(args) > 0 && args[0] == "-c" {
			return []byte("boom"), fmt.Errorf("exit 1")
		}
		return nil, nil
	}}
	ts, _ := newMutationTestServer(t, run)

	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/reload", "")
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if m := decodeJSONMap(t, resp); m["error"] != "reload failed" {
		t.Fatalf("body %v", m)
	}
}

func TestHandleReload_busyIs503(t *testing.T) {
	s := &Server{Token: "tok", Config: "/nonexistent", Listen: "127.0.0.1:0"}
	s.applyMu.Lock()
	defer s.applyMu.Unlock()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/reload", nil)
	s.handleReload(rec, req)
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status %d", rec.Code)
	}
}

func TestHandleUpdateGeo_disabledIs500(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})

	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/update-geo", "")
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if m := decodeJSONMap(t, resp); m["error"] != "geo update failed" {
		t.Fatalf("body %v", m)
	}
}

func TestHandleBackup_successAndPathValidation(t *testing.T) {
	backupDir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", backupDir)
	ts, _ := newMutationTestServer(t, stubRunner{})

	dest := filepath.Join(backupDir, "b.tgz")
	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/backup?path="+dest, "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if m := decodeJSONMap(t, resp); m["archive"] != dest {
		t.Fatalf("body %v", m)
	}

	// Outside the allowlist must be rejected before tar runs.
	resp = doAuthed(t, http.MethodPost, ts.URL+"/api/v1/backup?path=/etc/evil.tgz", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestHandleRestore_pathValidation(t *testing.T) {
	backupDir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", backupDir)
	ts, _ := newMutationTestServer(t, stubRunner{})

	// Missing path.
	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/restore", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
	// Path escaping the allowlist.
	resp = doAuthed(t, http.MethodPost, ts.URL+"/api/v1/restore?path=/etc/evil.tgz", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestHandlePeerGenerateKeypair_success(t *testing.T) {
	run := stubRunner{handler: func(name string, args []string) ([]byte, error) {
		if name == "wg" && len(args) == 1 && args[0] == "genkey" {
			return []byte("PRIVKEY==\n"), nil
		}
		if name == "wg" && len(args) == 1 && args[0] == "pubkey" {
			return []byte("PUBKEY==\n"), nil
		}
		return nil, fmt.Errorf("unexpected command %s %v", name, args)
	}}
	ts, _ := newMutationTestServer(t, run)

	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/generate-keypair", "")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	m := decodeJSONMap(t, resp)
	if m["private_key"] != "PRIVKEY==" || m["public_key"] != "PUBKEY==" {
		t.Fatalf("body %v", m)
	}
}

func TestHandlePeerGenerateKeypair_wgMissingIs500(t *testing.T) {
	run := stubRunner{handler: func(name string, args []string) ([]byte, error) {
		return nil, fmt.Errorf("wg: not found")
	}}
	ts, _ := newMutationTestServer(t, run)

	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/generate-keypair", "")
	if resp.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestHandlePeerOnboardBundle(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})

	// Missing passphrase.
	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/onboard-bundle", `{"passphrase":""}`)
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}

	// Complete request succeeds (pure crypto, no subprocess).
	body := `{
		"passphrase": "hunter2hunter2",
		"peer_private_key": "cGVlci1wcml2YXRlLWtleQ==",
		"peer_tunnel_address": "10.100.0.2/32",
		"server_public_key": "aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=",
		"endpoint": "vpn.example.org:51830",
		"allowed_ips": "10.100.0.0/24"
	}`
	resp = doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/onboard-bundle", body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	m := decodeJSONMap(t, resp)
	if s, _ := m["blob_base64"].(string); s == "" {
		t.Fatalf("empty blob: %v", m)
	}
}

func TestHandlePeerQR(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})

	// Out-of-range index.
	resp := doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/99/qr.png", "[Interface]")
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("status %d", resp.StatusCode)
	}

	// Empty body.
	resp = doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/0/qr.png", "")
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}

	// Valid conf renders a PNG.
	resp = doAuthed(t, http.MethodPost, ts.URL+"/api/v1/peers/0/qr.png", "[Interface]\nPrivateKey = x\n")
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "image/png" {
		t.Fatalf("content-type %q", ct)
	}
}
