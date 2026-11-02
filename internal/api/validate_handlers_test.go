package api

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Exercises the real path from the applied .bak snapshot to the /validate warnings. The
// status is 200 or 400 depending on whether nft is installed; warnings are present in both.
func TestHandleValidate_inputAllowRisk(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	applied := strings.Replace(string(cur), "input_allows: []", `input_allows:
  - proto: tcp
    dport: "22"
  - proto: tcp
    dport: "8443"`, 1)
	if err := os.WriteFile(cfgPath+".bak", []byte(applied), 0o644); err != nil {
		t.Fatal(err)
	}

	s := &Server{Token: "secret-token", Config: cfgPath, Listen: "127.0.0.1:0"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	tests := []struct {
		name          string
		forwardedPort string
		want          []string
	}{
		{name: "SSH rule removed", want: []string{"TCP port 22 (SSH)"}},
		{
			name:          "rule for the current connection removed too",
			forwardedPort: "8443",
			want:          []string{"TCP port 22 (SSH)", "TCP port 8443 (your current connection)"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/v1/validate", nil)
			req.Header.Set("Authorization", "Bearer secret-token")
			if tt.forwardedPort != "" {
				req.Header.Set("X-Forwarded-Port", tt.forwardedPort)
			}
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			var vr struct {
				Warnings []struct {
					Code    string `json:"code"`
					Message string `json:"message"`
				} `json:"warnings"`
			}
			if err := json.NewDecoder(resp.Body).Decode(&vr); err != nil {
				t.Fatal(err)
			}
			var got []string
			for _, w := range vr.Warnings {
				if w.Code == "lockout_risk_input_allows" {
					got = append(got, w.Message)
				}
			}
			if len(got) != len(tt.want) {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
			for i, want := range tt.want {
				if !strings.Contains(got[i], want) {
					t.Fatalf("warning %d: got %q, want %q", i, got[i], want)
				}
			}
		})
	}
}

func TestDetectConnPort(t *testing.T) {
	tests := []struct {
		name   string
		header string
		local  net.Addr
		want   int
	}{
		{name: "forwarded by the UI nginx", header: "9443", local: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9847}, want: 9443},
		{name: "direct on a public address", local: &net.TCPAddr{IP: net.IPv4(203, 0, 113, 1), Port: 9847}, want: 9847},
		{name: "direct on loopback bypasses INPUT rules", local: &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 9847}},
		{name: "invalid header falls back to the socket", header: "99999", local: &net.TCPAddr{IP: net.IPv4(203, 0, 113, 1), Port: 9847}, want: 9847},
		{name: "unknown"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/v1/validate", nil)
			if tt.header != "" {
				r.Header.Set("X-Forwarded-Port", tt.header)
			}
			if tt.local != nil {
				r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, tt.local))
			}
			if got := detectConnPort(r); got != tt.want {
				t.Fatalf("got %d, want %d", got, tt.want)
			}
		})
	}
}

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
