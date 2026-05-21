package gen

import (
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestNFTables_crowdsec_offByDefault(t *testing.T) {
	c := minimalConfig()
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "crowdsec_block_v4") {
		t.Fatal("crowdsec set should be omitted when disabled")
	}
}

func TestNFTables_crowdsec_enabled(t *testing.T) {
	c := minimalConfig()
	c.CrowdSec.Enabled = true
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{
		"set crowdsec_block_v4",
		"ip saddr @crowdsec_block_v4",
		`iifname "eth0" oifname "wg0" ip saddr @crowdsec_block_v4`,
		`log prefix "evuproxy-crowdsec: "`,
	} {
		if !strings.Contains(s, needle) {
			t.Fatalf("missing %q in generated nft", needle)
		}
	}
	// CrowdSec enforcement is inet forward/input only; ip prerouting must not reference the set.
	ipPreroute := s[strings.Index(s, "table ip evuproxy"):]
	if strings.Contains(ipPreroute, "crowdsec_block_v4") {
		t.Fatalf("ip table should not reference crowdsec set (bouncer uses inet only): %s", ipPreroute)
	}
}

func minimalConfig() *config.Config {
	return &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.10"},
			},
		},
		Geo: config.Geo{Enabled: false},
	}
}
