package apply

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestEndpointHostWarnings_cloudflareAAAA(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(`wireguard:
  interface: wg0
  listen_port: 51830
  private_key_file: /k
  address: 10.100.0.1/24
network:
  public_interface: eth0
`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ui-preferences.json"), []byte(
		`{"wireguard_server_endpoint":"pangolin.example.com:51830","peer_tunnel_subnet_cidr":"10.100.0.0/24"}`,
	), 0o644); err != nil {
		t.Fatal(err)
	}

	restoreLookup := SwapLookupIPForTest(func(host string) ([]net.IP, error) {
		if host != "pangolin.example.com" {
			t.Fatalf("host %q", host)
		}
		return []net.IP{
			net.ParseIP("95.211.40.143"),
			net.ParseIP("2606:4700:3035::ac43:9846"),
		}, nil
	})
	defer restoreLookup()
	restoreAddrs := SwapHostPublicAddrsForTest(func(ctx context.Context, pubIF string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("95.211.40.143")}, nil
	})
	defer restoreAddrs()

	c, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	ws := WireGuardHostWarnings(context.Background(), c, cfgPath)
	var found bool
	for _, w := range ws {
		if w.Code == "wg_endpoint_host_mismatch" {
			found = true
			if !strings.Contains(w.Message, "Cloudflare") {
				t.Fatalf("want Cloudflare hint: %s", w.Message)
			}
			if !strings.Contains(w.Message, "2606:4700") {
				t.Fatalf("want resolved CF addr in message: %s", w.Message)
			}
		}
	}
	if !found {
		t.Fatalf("expected wg_endpoint_host_mismatch, got %+v", ws)
	}
}

func TestEndpointHostWarnings_matchingDNS(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte(`wireguard:
  interface: wg0
  listen_port: 51830
  private_key_file: /k
  address: 10.100.0.1/24
network:
  public_interface: eth0
`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "ui-preferences.json"), []byte(
		`{"wireguard_server_endpoint":"vpn.example:51830"}`,
	), 0o644); err != nil {
		t.Fatal(err)
	}
	restoreLookup := SwapLookupIPForTest(func(host string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("203.0.113.10")}, nil
	})
	defer restoreLookup()
	restoreAddrs := SwapHostPublicAddrsForTest(func(ctx context.Context, pubIF string) ([]net.IP, error) {
		return []net.IP{net.ParseIP("203.0.113.10")}, nil
	})
	defer restoreAddrs()

	c, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, w := range WireGuardHostWarnings(context.Background(), c, cfgPath) {
		if w.Code == "wg_endpoint_host_mismatch" || w.Code == "wg_endpoint_dns_lookup_failed" {
			t.Fatalf("unexpected warning: %+v", w)
		}
	}
}

func TestSplitEndpointHostPort(t *testing.T) {
	h, p, err := splitEndpointHostPort("vpn.example.com:51830")
	if err != nil || h != "vpn.example.com" || p != "51830" {
		t.Fatalf("%q %q %v", h, p, err)
	}
	h, p, err = splitEndpointHostPort("[2001:db8::1]:51830")
	if err != nil || h != "2001:db8::1" || p != "51830" {
		t.Fatalf("%q %q %v", h, p, err)
	}
}
