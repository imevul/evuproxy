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

const csrfTestHost = "192.168.1.10:9080"

func newCSRFTestServer(t *testing.T, corsOrigins string) *Server {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	return &Server{
		Token:       "secret-token",
		Config:      cfgPath,
		Listen:      "127.0.0.1:0",
		CORSOrigins: corsOrigins,
	}
}

func notesRequest(headers map[string]string) *http.Request {
	req := httptest.NewRequest(http.MethodPut, "/api/v1/config/notes", strings.NewReader(`{"text":"hello"}`))
	req.Host = csrfTestHost
	req.Header.Set("Authorization", "Bearer secret-token")
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	return req
}

func assertRefused(t *testing.T, rec *httptest.ResponseRecorder) {
	t.Helper()
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status %d want 403: %s", rec.Code, rec.Body)
	}
	var body map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["error_code"] != "cross_origin_refused" {
		t.Fatalf("error_code %q", body["error_code"])
	}
}

func TestCrossOriginGuard_allowed(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		cors    string
		headers map[string]string
	}{
		{name: "non-browser client sends neither header"},
		{name: "same-origin fetch", headers: map[string]string{"Sec-Fetch-Site": "same-origin", "Origin": "https://" + csrfTestHost}},
		{name: "user-initiated", headers: map[string]string{"Sec-Fetch-Site": "none"}},
		{name: "plain HTTP UI, no fetch metadata, Origin matches Host", headers: map[string]string{"Origin": "http://" + csrfTestHost}},
		{
			name:    "listed origin cross-site",
			cors:    "https://ui.example",
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://ui.example"},
		},
		{
			name:    "listed origin without fetch metadata",
			cors:    "http://10.0.0.2:9080",
			headers: map[string]string{"Origin": "http://10.0.0.2:9080"},
		},
		{
			name:    "cors star turns the guard off",
			cors:    "*",
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s := newCSRFTestServer(t, tc.cors)
			rec := httptest.NewRecorder()
			s.Routes().ServeHTTP(rec, notesRequest(tc.headers))
			if rec.Code != http.StatusOK {
				t.Fatalf("status %d: %s", rec.Code, rec.Body)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(s.Config), "config-notes.txt")); err != nil {
				t.Fatalf("notes not written: %v", err)
			}
		})
	}
}

func TestCrossOriginGuard_refused(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		cors    string
		headers map[string]string
	}{
		{name: "cross-site", headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}},
		{name: "cross-site without Origin", headers: map[string]string{"Sec-Fetch-Site": "cross-site"}},
		{name: "same-site is not same-origin", headers: map[string]string{"Sec-Fetch-Site": "same-site", "Origin": "https://other.example"}},
		{name: "no fetch metadata, Origin differs", headers: map[string]string{"Origin": "http://evil.example"}},
		{name: "no fetch metadata, same host on another port", headers: map[string]string{"Origin": "http://192.168.1.10:9999"}},
		{
			name:    "origin not on the list",
			cors:    "https://ui.example",
			headers: map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"},
		},
		{
			name:    "null origin stays refused even when listed",
			cors:    "null",
			headers: map[string]string{"Origin": "null"},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			s := newCSRFTestServer(t, tc.cors)
			rec := httptest.NewRecorder()
			s.Routes().ServeHTTP(rec, notesRequest(tc.headers))
			assertRefused(t, rec)
			if _, err := os.Stat(filepath.Join(filepath.Dir(s.Config), "config-notes.txt")); !os.IsNotExist(err) {
				t.Fatalf("handler ran despite refusal: %v", err)
			}
		})
	}
}

// A reverse proxy may inject the token, which is the case the guard exists for, so refusal must not
// depend on the token being absent. The handlers below would touch the host if they ran.
func TestCrossOriginGuard_coversEveryUnsafeMethod(t *testing.T) {
	t.Parallel()
	s := newCSRFTestServer(t, "")
	h := s.Routes()
	for _, target := range []struct{ method, path string }{
		{http.MethodPost, "/api/v1/reload"},
		{http.MethodPost, "/api/v1/update-geo"},
		{http.MethodPost, "/api/v1/restore"},
		{http.MethodPost, "/api/v1/backup"},
		{http.MethodPost, "/api/v1/config/discard"},
		{http.MethodPost, "/api/v1/config/restore-previous-applied"},
		{http.MethodPut, "/api/v1/config"},
		{http.MethodPut, "/api/v1/preferences"},
		{http.MethodDelete, "/api/v1/config"},
		{http.MethodPatch, "/api/v1/config"},
	} {
		for _, authz := range []string{"Bearer secret-token", ""} {
			req := httptest.NewRequest(target.method, target.path, strings.NewReader(""))
			req.Host = csrfTestHost
			req.Header.Set("Sec-Fetch-Site", "cross-site")
			req.Header.Set("Origin", "https://evil.example")
			if authz != "" {
				req.Header.Set("Authorization", authz)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			assertRefused(t, rec)
		}
	}
}

func TestCrossOriginGuard_safeMethodsPass(t *testing.T) {
	t.Parallel()
	s := newCSRFTestServer(t, "")
	req := httptest.NewRequest(http.MethodGet, "/api/v1/config", nil)
	req.Host = csrfTestHost
	req.Header.Set("Authorization", "Bearer secret-token")
	req.Header.Set("Sec-Fetch-Site", "cross-site")
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	s.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body)
	}
}

// A refusal must not hand CORS approval to the origin it refused.
func TestCrossOriginGuard_refusalOmitsCORSHeaders(t *testing.T) {
	t.Parallel()
	s := newCSRFTestServer(t, "https://ui.example")
	rec := httptest.NewRecorder()
	testHandler(s).ServeHTTP(rec, notesRequest(map[string]string{"Sec-Fetch-Site": "cross-site", "Origin": "https://evil.example"}))
	assertRefused(t, rec)
	if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "" {
		t.Fatalf("unlisted origin got allow-origin %q", got)
	}
}

// Sec-Fetch-Site is not sent over plain HTTP outside localhost, so the guard falls back to comparing
// Origin with Host there. nginx's $host drops the port, which would refuse every UI save on a LAN bind.
func TestUINginxForwardsHostWithPort(t *testing.T) {
	t.Parallel()
	for _, name := range []string{"nginx.conf", "nginx.dev.conf"} {
		b, err := os.ReadFile(filepath.Join("..", "..", "docker", name))
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(b), "proxy_set_header Host $http_host;") {
			t.Fatalf("%s must forward the Host header with its port", name)
		}
	}
}
