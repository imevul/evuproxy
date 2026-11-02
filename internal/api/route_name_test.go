package api

import (
	"io"
	"net/http"
	"os"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
)

func firstRoute(cfg map[string]any) map[string]any {
	return cfg["forwarding"].(map[string]any)["routes"].([]any)[0].(map[string]any)
}

// A config from before forwarding.routes[].name must survive a UI save with no name key.
func TestConfigPut_routeWithoutNameStaysUnnamed(t *testing.T) {
	ts, cfgPath := newMutationTestServer(t, stubRunner{})
	etag, cfg := getConfigRevision(t, ts.URL)
	if _, ok := firstRoute(cfg)["name"]; ok {
		t.Fatalf("GET /config invented a name: %v", firstRoute(cfg))
	}

	resp := putConfigIfMatch(t, ts.URL, cfg, etag)
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	raw, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	var keys map[string]any
	if err := yaml.Unmarshal(raw, &keys); err != nil {
		t.Fatal(err)
	}
	if _, ok := firstRoute(keys)["name"]; ok {
		t.Fatalf("saved a route name key:\n%s", raw)
	}
	var onDisk config.Config
	if err := yaml.Unmarshal(raw, &onDisk); err != nil {
		t.Fatal(err)
	}
	r := onDisk.Forwarding.Routes[0]
	if r.Name != "" || r.Proto != "tcp" || r.TargetIP != "10.100.0.2" || len(r.Ports) != 1 || r.Ports[0] != "80" {
		t.Fatalf("route changed: %+v", r)
	}
}

func TestConfigPut_routeNameSavedAndValidated(t *testing.T) {
	ts, _ := newMutationTestServer(t, stubRunner{})

	etag, cfg := getConfigRevision(t, ts.URL)
	firstRoute(cfg)["name"] = "Web"
	if resp := putConfigIfMatch(t, ts.URL, cfg, etag); resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	etag, cfg = getConfigRevision(t, ts.URL)
	if got := firstRoute(cfg)["name"]; got != "Web" {
		t.Fatalf("name = %v", got)
	}

	firstRoute(cfg)["name"] = "bad\nname"
	if resp := putConfigIfMatch(t, ts.URL, cfg, etag); resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("control character in name: status %d", resp.StatusCode)
	}
}
