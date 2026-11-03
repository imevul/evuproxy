package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const metricsTestHelp = "# HELP evuproxy_apply_success_total"

func writeMetricsTestConfig(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	body := `wireguard:
  interface: wg0
  listen_port: 51830
  private_key_file: ` + filepath.Join(dir, "wg.key") + `
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes: []
peers: []
`
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "wg.key"), []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return cfgPath
}

func TestGET_metrics_prometheusText(t *testing.T) {
	rr := httptest.NewRecorder()
	metricsHandler(writeMetricsTestConfig(t), "").ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if rr.Code != http.StatusOK {
		t.Fatalf("status %d body %s", rr.Code, rr.Body.String())
	}
	if !strings.Contains(rr.Body.String(), metricsTestHelp) {
		t.Fatalf("unexpected body:\n%s", rr.Body.String())
	}
	if got := rr.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/plain; version=0.0.4") {
		t.Fatalf("Content-Type %q", got)
	}
}

func TestGET_metrics_token(t *testing.T) {
	cfgPath := writeMetricsTestConfig(t)
	const token = "metrics-secret"

	for _, tc := range []struct {
		name   string
		token  string
		header map[string]string
		want   int
	}{
		{name: "no token configured, none sent", want: http.StatusOK},
		{name: "no token configured, one sent", header: map[string]string{"Authorization": "Bearer anything"}, want: http.StatusOK},
		{name: "correct", token: token, header: map[string]string{"Authorization": "Bearer " + token}, want: http.StatusOK},
		{name: "missing", token: token, want: http.StatusUnauthorized},
		{name: "wrong", token: token, header: map[string]string{"Authorization": "Bearer nope"}, want: http.StatusUnauthorized},
		{name: "empty bearer", token: token, header: map[string]string{"Authorization": "Bearer "}, want: http.StatusUnauthorized},
		{name: "not a bearer scheme", token: token, header: map[string]string{"Authorization": "Basic " + token}, want: http.StatusUnauthorized},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
			for k, v := range tc.header {
				req.Header.Set(k, v)
			}
			rr := httptest.NewRecorder()
			metricsHandler(cfgPath, tc.token).ServeHTTP(rr, req)

			if rr.Code != tc.want {
				t.Fatalf("status %d, want %d, body %s", rr.Code, tc.want, rr.Body.String())
			}
			if got := strings.Contains(rr.Body.String(), metricsTestHelp); got != (tc.want == http.StatusOK) {
				t.Fatalf("metrics in body = %v at status %d:\n%s", got, rr.Code, rr.Body.String())
			}
			if tc.want == http.StatusUnauthorized && rr.Header().Get("WWW-Authenticate") != "Bearer" {
				t.Fatalf("WWW-Authenticate %q", rr.Header().Get("WWW-Authenticate"))
			}
		})
	}
}

// A HEAD also reaches the GET route, and its status would otherwise confirm a guess.
func TestHEAD_metrics_needsTheToken(t *testing.T) {
	rr := httptest.NewRecorder()
	metricsHandler(writeMetricsTestConfig(t), "metrics-secret").ServeHTTP(rr, httptest.NewRequest(http.MethodHead, "/metrics", nil))
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status %d", rr.Code)
	}
}
