package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/autopause"
	"github.com/imevul/evuproxy/internal/config"
)

// offlineProber reports no handshake for any peer, and no ping reply.
type offlineProber struct{}

func (offlineProber) Handshakes(string) (map[string]int64, error) { return map[string]int64{}, nil }
func (offlineProber) Ping(context.Context, string) error          { return context.DeadlineExceeded }

func getAutoPause(t *testing.T, s *Server) string {
	t.Helper()
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	req, err := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/auto-pause", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var body json.RawMessage
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func TestAutoPause_requiresAuth(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	ts := httptest.NewServer((&Server{Token: "secret-token", Config: cfgPath}).Routes())
	t.Cleanup(ts.Close)

	resp, err := http.Get(ts.URL + "/api/v1/auto-pause")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestAutoPause_emptyListWithoutLoop(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	got := getAutoPause(t, &Server{Token: "secret-token", Config: cfgPath})
	if want := `{"paused_routes":[]}`; got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestAutoPause_listsPausedRoutes(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0"},
		AutoPause: config.AutoPause{FailuresToPause: 1},
		Peers:     []config.Peer{{Name: "alpha", PublicKey: "k", TunnelIP: "10.100.0.2/32"}},
		Forwarding: config.Forwarding{Routes: []config.ForwardRoute{
			{Name: "Game", Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2", PauseWhenPeerOffline: true},
			{Proto: "udp", Ports: []string{"53"}, TargetIP: "10.100.0.2"},
		}},
	}
	loop := &autopause.Loop{
		Load:   func() (*config.Config, error) { return c, nil },
		Prober: offlineProber{},
	}

	s := &Server{Token: "secret-token", Config: cfgPath, autoPause: loop}
	if got, want := getAutoPause(t, s), `{"paused_routes":[]}`; got != want {
		t.Fatalf("before a probe: got %s, want %s", got, want)
	}

	loop.Tick(context.Background())
	want := `{"paused_routes":[{"name":"Game","proto":"tcp","ports":["25565"],"target_ip":"10.100.0.2","peer":"alpha"}]}`
	if got := getAutoPause(t, s); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}
