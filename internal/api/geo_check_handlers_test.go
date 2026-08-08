package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestHandleGeoCheckIP(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	zoneDir := filepath.Join(dir, "zones")
	if err := os.MkdirAll(zoneDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(zoneDir, "se.zone"), []byte("203.0.113.0/24\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{Token: "secret-token", Config: cfgPath, Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	draft := map[string]any{
		"ip": "203.0.113.9",
		"config": map[string]any{
			"wireguard": map[string]any{
				"interface": "wg0", "listen_port": 51830,
				"private_key_file": "/k", "address": "10.100.0.1/24",
			},
			"network": map[string]any{"public_interface": "eth0"},
			"geo": map[string]any{
				"enabled": true, "mode": "allow",
				"countries": []string{"se"}, "zone_dir": zoneDir,
			},
			"forwarding": map[string]any{"routes": []any{}},
			"peers": []any{
				map[string]any{"name": "a", "public_key": "x", "tunnel_ip": "10.100.0.2/32"},
			},
		},
	}
	body, _ := json.Marshal(draft)
	req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/geo/check-ip", strings.NewReader(string(body)))
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var out struct {
		OK               bool   `json:"ok"`
		Verdict          string `json:"verdict"`
		CheckedFromDraft bool   `json:"checked_from_draft"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	if !out.OK || out.Verdict != "allowed" || !out.CheckedFromDraft {
		t.Fatalf("got %+v", out)
	}

	reqMissing, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/geo/check-ip", strings.NewReader(`{}`))
	reqMissing.Header.Set("Authorization", "Bearer secret-token")
	respMissing, err := http.DefaultClient.Do(reqMissing)
	if err != nil {
		t.Fatal(err)
	}
	defer respMissing.Body.Close()
	if respMissing.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400 for missing ip, got %d", respMissing.StatusCode)
	}
}
