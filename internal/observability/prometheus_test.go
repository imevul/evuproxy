package observability

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/state"
)

func TestPrometheusText_containsMetrics(t *testing.T) {
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
	_ = state.RecordApplySuccess(cfgPath)
	out, err := PrometheusText(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	s := string(out)
	for _, needle := range []string{
		"# HELP evuproxy_apply_success_total",
		"# TYPE evuproxy_peers_online gauge",
		"evuproxy_maintenance_mode",
		"# TYPE evuproxy_route_accepted_packets_total counter",
		"# TYPE evuproxy_route_accepted_bytes_total counter",
	} {
		if !strings.Contains(s, needle) {
			t.Fatalf("missing %q in:\n%s", needle, s)
		}
	}
}

// A scrape has no use for the whole-table listings, which load the geo sets on older nft. nft here
// is a script on PATH that notes its arguments, because PrometheusText runs the real commands.
func TestPrometheusText_listsNoWholeTable(t *testing.T) {
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
	for _, p := range []string{cfgPath, state.ConfigYAMLBackupPath(cfgPath)} {
		if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "wg.key"), []byte("dGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXktdGVzdC1rZXk=\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	calls := filepath.Join(bin, "calls")
	script := "#!/bin/sh\necho \"$*\" >>" + calls + "\n"
	if err := os.WriteFile(filepath.Join(bin, "nft"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	if _, err := PrometheusText(cfgPath); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(calls)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(got), "list table") || !strings.Contains(string(got), "list chain inet evuproxy_accepted route_accepted") {
		t.Fatalf("nft calls:\n%s", got)
	}
}

func TestWriteRouteAccepted(t *testing.T) {
	var b strings.Builder
	writeRouteAccepted(&b, []apply.RouteAcceptedCounter{
		{RouteIndex: 0, Name: "game", Proto: "tcp", Ports: []string{"18080"}, TargetIP: "10.100.0.2", Packets: 12, Bytes: 720},
		{RouteIndex: 1, Proto: "tcp", Ports: []string{"18082"}, TargetIP: "10.100.0.2", Packets: 3, Bytes: 180},
		{RouteIndex: 3, Name: "game", Proto: "tcp", Ports: []string{"19000"}, TargetIP: "10.100.0.3", Packets: 5, Bytes: 300},
		{RouteIndex: 3, Name: "game", Proto: "udp", Ports: []string{"19000"}, TargetIP: "10.100.0.3", Packets: 18446744073709551615, Bytes: 0},
	})
	want := `# HELP evuproxy_route_accepted_packets_total Inbound packets the firewall accepted for a route since the last Apply (accepted traffic, not players or legitimate clients)
# TYPE evuproxy_route_accepted_packets_total counter
evuproxy_route_accepted_packets_total{route_index="0",name="game",proto="tcp"} 12
evuproxy_route_accepted_packets_total{route_index="1",name="",proto="tcp"} 3
evuproxy_route_accepted_packets_total{route_index="3",name="game",proto="tcp"} 5
evuproxy_route_accepted_packets_total{route_index="3",name="game",proto="udp"} 18446744073709551615
# HELP evuproxy_route_accepted_bytes_total Inbound bytes the firewall accepted for a route since the last Apply (accepted traffic, not players or legitimate clients)
# TYPE evuproxy_route_accepted_bytes_total counter
evuproxy_route_accepted_bytes_total{route_index="0",name="game",proto="tcp"} 720
evuproxy_route_accepted_bytes_total{route_index="1",name="",proto="tcp"} 180
evuproxy_route_accepted_bytes_total{route_index="3",name="game",proto="tcp"} 300
evuproxy_route_accepted_bytes_total{route_index="3",name="game",proto="udp"} 0
`
	if got := b.String(); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestWriteRouteAccepted_noRowsKeepsTheHeaders(t *testing.T) {
	var b strings.Builder
	writeRouteAccepted(&b, nil)
	want := `# HELP evuproxy_route_accepted_packets_total Inbound packets the firewall accepted for a route since the last Apply (accepted traffic, not players or legitimate clients)
# TYPE evuproxy_route_accepted_packets_total counter
# HELP evuproxy_route_accepted_bytes_total Inbound bytes the firewall accepted for a route since the last Apply (accepted traffic, not players or legitimate clients)
# TYPE evuproxy_route_accepted_bytes_total counter
`
	if got := b.String(); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
}

func TestWriteRouteAccepted_escapesName(t *testing.T) {
	var b strings.Builder
	writeRouteAccepted(&b, []apply.RouteAcceptedCounter{
		{RouteIndex: 0, Name: "a\"b\\c\nd", Proto: "udp", Packets: 1, Bytes: 2},
	})
	want := `evuproxy_route_accepted_packets_total{route_index="0",name="a\"b\\c\nd",proto="udp"} 1` + "\n"
	if !strings.Contains(b.String(), want) {
		t.Fatalf("missing %q in:\n%s", want, b.String())
	}
}

func TestValidateMetricsListen_loopback(t *testing.T) {
	if err := ValidateMetricsListen("127.0.0.1:9848"); err != nil {
		t.Fatal(err)
	}
	if err := ValidateMetricsListen("0.0.0.0:9848"); err == nil {
		t.Fatal("expected error for non-loopback")
	}
	if err := ValidateMetricsListen("[::1]:9848"); err != nil {
		t.Fatal(err)
	}
}
