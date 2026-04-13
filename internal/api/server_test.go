package api

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestAuth_unauthorizedWithoutTokenHeader(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "secret-token",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/v1/config")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestAuth_okWithBearer(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "secret-token",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/config", nil)
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestAuth_serviceUnavailableWhenTokenNotConfigured(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/config", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestConfigPut_rejectsInvalidJSON(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", strings.NewReader(`{`))
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["error"] == "" || strings.Contains(body["error"], "unexpected") {
		t.Fatalf("client error should be stable, got %q", body["error"])
	}
}

func TestConfigPut_rejectsOversizeBody(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	large := bytes.Repeat([]byte(` `), 3<<20)
	req, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(large))
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d want 413", resp.StatusCode)
	}
}

func testHandler(s *Server) http.Handler {
	h := s.Routes()
	if cors := parseCORSOrigins(s.CORSOrigins); cors != nil {
		h = cors.wrap(h)
	}
	return h
}

func TestCORSPreflight_allowsConfiguredOrigin(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:       "t",
		Config:      cfgPath,
		Listen:      "127.0.0.1:0",
		CORSOrigins: "https://ui.example",
	}
	ts := httptest.NewServer(testHandler(s))
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/v1/config", nil)
	req.Header.Set("Origin", "https://ui.example")
	req.Header.Set("Access-Control-Request-Method", "GET")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "https://ui.example" {
		t.Fatalf("allow-origin %q", got)
	}
}

func writeMinimalConfig(t *testing.T, path string) {
	t.Helper()
	b := []byte(`wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: /etc/k
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes:
    - proto: tcp
      ports: ["80"]
      target_ip: 10.100.0.2
geo:
  enabled: false
  set_name: geo_v4
  countries: []
  zone_dir: /tmp/z
input_allows: []
peers:
  - name: p1
    public_key: aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=
    tunnel_ip: 10.100.0.2/32
`)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfigUndo_backupFlagAndRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/config", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get config %d", resp.StatusCode)
	}
	var c config.Config
	if err := json.NewDecoder(resp.Body).Decode(&c); err != nil {
		t.Fatal(err)
	}
	if c.WireGuard.ListenPort != 51830 {
		t.Fatalf("unexpected initial port %d", c.WireGuard.ListenPort)
	}
	c.WireGuard.ListenPort = 51831
	putBody, err := json.Marshal(&c)
	if err != nil {
		t.Fatal(err)
	}
	reqPut, _ := http.NewRequest(http.MethodPut, ts.URL+"/api/v1/config", bytes.NewReader(putBody))
	reqPut.Header.Set("Authorization", "Bearer t")
	reqPut.Header.Set("Content-Type", "application/json")
	respPut, err := http.DefaultClient.Do(reqPut)
	if err != nil {
		t.Fatal(err)
	}
	defer respPut.Body.Close()
	if respPut.StatusCode != http.StatusOK {
		t.Fatalf("put config %d", respPut.StatusCode)
	}

	reqPen, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/pending", nil)
	reqPen.Header.Set("Authorization", "Bearer t")
	respPen, err := http.DefaultClient.Do(reqPen)
	if err != nil {
		t.Fatal(err)
	}
	defer respPen.Body.Close()
	if respPen.StatusCode != http.StatusOK {
		t.Fatalf("pending %d", respPen.StatusCode)
	}
	var pen struct {
		ConfigBackupAvailable bool `json:"config_backup_available"`
	}
	if err := json.NewDecoder(respPen.Body).Decode(&pen); err != nil {
		t.Fatal(err)
	}
	if !pen.ConfigBackupAvailable {
		t.Fatal("expected config_backup_available after put")
	}

	reqUndo, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/config/undo", nil)
	reqUndo.Header.Set("Authorization", "Bearer t")
	respUndo, err := http.DefaultClient.Do(reqUndo)
	if err != nil {
		t.Fatal(err)
	}
	defer respUndo.Body.Close()
	if respUndo.StatusCode != http.StatusOK {
		t.Fatalf("undo %d", respUndo.StatusCode)
	}

	reqAfter, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/config", nil)
	reqAfter.Header.Set("Authorization", "Bearer t")
	respAfter, err := http.DefaultClient.Do(reqAfter)
	if err != nil {
		t.Fatal(err)
	}
	defer respAfter.Body.Close()
	var c2 config.Config
	if err := json.NewDecoder(respAfter.Body).Decode(&c2); err != nil {
		t.Fatal(err)
	}
	if c2.WireGuard.ListenPort != 51830 {
		t.Fatalf("after undo want port 51830, got %d", c2.WireGuard.ListenPort)
	}
}

func TestConfigUndo_failsWithoutBackup(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	reqUndo, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/config/undo", nil)
	reqUndo.Header.Set("Authorization", "Bearer t")
	respUndo, err := http.DefaultClient.Do(reqUndo)
	if err != nil {
		t.Fatal(err)
	}
	defer respUndo.Body.Close()
	if respUndo.StatusCode != http.StatusBadRequest {
		t.Fatalf("undo %d want 400", respUndo.StatusCode)
	}
}

func TestHealthz_unauthenticated(t *testing.T) {
	s := &Server{Token: "t", Config: "/x", Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	resp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(resp.Body)
	if string(b) != "ok" {
		t.Fatalf("body %q", b)
	}
}
