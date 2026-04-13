package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
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

func TestAuth_okWithLowercaseBearerScheme(t *testing.T) {
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
	req.Header.Set("Authorization", "bearer secret-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
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
	writeMinimalConfigPort(t, path, 51830)
}

func writeMinimalConfigPort(t *testing.T, path string, listenPort int) {
	t.Helper()
	b := fmt.Appendf(nil, `wireguard:
  interface: evu0
  listen_port: %d
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
`, listenPort)
	if err := os.WriteFile(path, b, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestConfigDiscard_pendingFlagAndRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	bakPath := cfgPath + ".bak"
	writeMinimalConfigPort(t, bakPath, 51829)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

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
		DiscardAvailable bool `json:"discard_available"`
	}
	if err := json.NewDecoder(respPen.Body).Decode(&pen); err != nil {
		t.Fatal(err)
	}
	if !pen.DiscardAvailable {
		t.Fatal("expected discard_available when yaml differs from .bak")
	}

	reqDis, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/config/discard", nil)
	reqDis.Header.Set("Authorization", "Bearer t")
	respDis, err := http.DefaultClient.Do(reqDis)
	if err != nil {
		t.Fatal(err)
	}
	defer respDis.Body.Close()
	if respDis.StatusCode != http.StatusOK {
		t.Fatalf("discard %d", respDis.StatusCode)
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
	if c2.WireGuard.ListenPort != 51829 {
		t.Fatalf("after discard want port from .bak 51829, got %d", c2.WireGuard.ListenPort)
	}
}

func TestConfigRestorePreviousApplied_roundTrip(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfigPort(t, cfgPath+".bak", 51831)
	writeMinimalConfig(t, cfgPath+".bak.1")
	writeMinimalConfigPort(t, cfgPath, 51899)

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	reqRes, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/config/restore-previous-applied", nil)
	reqRes.Header.Set("Authorization", "Bearer t")
	respRes, err := http.DefaultClient.Do(reqRes)
	if err != nil {
		t.Fatal(err)
	}
	defer respRes.Body.Close()
	if respRes.StatusCode != http.StatusOK {
		t.Fatalf("restore %d", respRes.StatusCode)
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
		t.Fatalf("after restore want port 51830 from .bak.1, got %d", c2.WireGuard.ListenPort)
	}
}

func TestConfigRestorePreviousApplied_failsWithoutHistory(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath+".bak", cur, 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{
		Token:  "t",
		Config: cfgPath,
		Listen: "127.0.0.1:0",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	reqRes, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/config/restore-previous-applied", nil)
	reqRes.Header.Set("Authorization", "Bearer t")
	respRes, err := http.DefaultClient.Do(reqRes)
	if err != nil {
		t.Fatal(err)
	}
	defer respRes.Body.Close()
	if respRes.StatusCode != http.StatusBadRequest {
		t.Fatalf("restore %d want 400", respRes.StatusCode)
	}
}

func TestEventsGet_invalidLimit(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	el, err := eventlog.New(filepath.Dir(cfgPath), eventlog.DefaultMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{
		Token:    "t",
		Config:   cfgPath,
		Listen:   "127.0.0.1:0",
		EventLog: el,
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/events?limit=999", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d want 400", resp.StatusCode)
	}
}

func TestConfigYAMLGet_ok(t *testing.T) {
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

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/config.yaml", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "wireguard:") {
		t.Fatalf("unexpected body %q", b)
	}
}

func TestRouteTest_clientErrorStable(t *testing.T) {
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

	body := strings.NewReader(`{"route_index": 99}`)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/routes/test", body)
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d want 400", resp.StatusCode)
	}
	var out map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if out["error"] != "invalid route index" {
		t.Fatalf("error %q", out["error"])
	}
}

func TestRouteTest_rateLimit(t *testing.T) {
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

	for i := 0; i < 10; i++ {
		body := strings.NewReader(`{"route_index": 99}`)
		req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/routes/test", body)
		req.Header.Set("Authorization", "Bearer t")
		req.Header.Set("Content-Type", "application/json")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("iter %d status %d want 400", i, resp.StatusCode)
		}
	}
	body := strings.NewReader(`{"route_index": 99}`)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/routes/test", body)
	req.Header.Set("Authorization", "Bearer t")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status %d want 429", resp.StatusCode)
	}
}

func TestLogs_rateLimit(t *testing.T) {
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

	for i := 0; i < 20; i++ {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/logs", nil)
		req.Header.Set("Authorization", "Bearer t")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/logs", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status %d want 429", resp.StatusCode)
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
