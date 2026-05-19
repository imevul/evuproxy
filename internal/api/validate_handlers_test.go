package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleValidate_andClientIP(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	s := &Server{Token: "secret-token", Config: cfgPath, Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/validate", strings.NewReader("{}"))
	req.Header.Set("Authorization", "Bearer secret-token")
	req.RemoteAddr = "203.0.113.5:12345"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("validate status %d", resp.StatusCode)
	}
	var vr struct {
		OK               bool   `json:"ok"`
		DetectedClientIP string `json:"detected_client_ip"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&vr)
	if vr.DetectedClientIP == "" {
		t.Fatalf("expected detected_client_ip, got %+v", vr)
	}

	req2, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/client-ip", nil)
	req2.Header.Set("Authorization", "Bearer secret-token")
	req2.RemoteAddr = "203.0.113.5:9847"
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("client-ip status %d", resp2.StatusCode)
	}
}
