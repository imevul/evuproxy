package gen

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func pausedTestConfig() *config.Config {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
		{Proto: "tcp,udp", Ports: []string{"8443", "9000-9001"}, TargetIP: "10.100.0.3", PauseWhenPeerOffline: true},
	}
	return c
}

// preroutingOf returns the rules of chain prerouting in a rendered ruleset or update.
func preroutingOf(t *testing.T, s string) string {
	t.Helper()
	_, rest, ok := strings.Cut(s, "type nat hook prerouting priority -100;\n")
	if !ok {
		t.Fatalf("no prerouting chain in:\n%s", s)
	}
	rules, _, ok := strings.Cut(rest, "    }\n")
	if !ok {
		t.Fatalf("prerouting chain isn't closed in:\n%s", s)
	}
	return rules
}

func TestNATPreroutingUpdate_pausedRouteHasNoDNAT(t *testing.T) {
	s, err := NATPreroutingUpdate(pausedTestConfig(), []int{1})
	if err != nil {
		t.Fatal(err)
	}
	rules := preroutingOf(t, s)
	if strings.Contains(rules, "10.100.0.3") {
		t.Fatalf("paused route still has DNAT:\n%s", rules)
	}
	if !strings.Contains(rules, "tcp dport 25565 dnat to 10.100.0.2") {
		t.Fatalf("the running route lost its DNAT:\n%s", rules)
	}
	for _, want := range []string{
		`tcp dport { 8443, 9000-9001 } drop comment "evuproxy-paused:1"`,
		`udp dport { 8443, 9000-9001 } drop comment "evuproxy-paused:1"`,
	} {
		if !strings.Contains(rules, want) {
			t.Fatalf("missing %q in:\n%s", want, rules)
		}
	}
}

func TestNATPreroutingUpdate_resumedMatchesFullRuleset(t *testing.T) {
	c := pausedTestConfig()
	full, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NATPreroutingUpdate(c, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got, want := preroutingOf(t, s), preroutingOf(t, full); got != want {
		t.Fatalf("resumed chain differs from a full reload:\n%s\nwant:\n%s", got, want)
	}
}

// The update replaces one chain and nothing else, so a pause can't flush geo sets, CrowdSec bans
// or rate-limit state.
func TestNATPreroutingUpdate_touchesOnlyPrerouting(t *testing.T) {
	c := pausedTestConfig()
	c.Geo = config.Geo{Enabled: true, Mode: "allow", SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"}
	s, err := NATPreroutingUpdate(c, []int{1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(s[strings.Index(s, "flush"):], "flush chain ip evuproxy prerouting\n") {
		t.Fatalf("doesn't start by flushing prerouting:\n%s", s)
	}
	for _, unwanted := range []string{"delete table", "inet evuproxy", "set geo_v4 {", "postrouting", "chain input", "chain forward"} {
		if strings.Contains(s, unwanted) {
			t.Fatalf("update contains %q:\n%s", unwanted, s)
		}
	}
}

// A full render knows nothing about pauses, so an Apply and the pending preview always come from
// config alone, and a paused route's other rules are there when it resumes.
func TestNFTables_ignoresPause(t *testing.T) {
	full, err := NFTables(pausedTestConfig())
	if err != nil {
		t.Fatal(err)
	}
	if got := PausedRoutesIn(full); len(got) != 0 {
		t.Fatalf("full ruleset marks %v as paused", got)
	}
	if !strings.Contains(full, "tcp dport 8443 dnat to 10.100.0.3") {
		t.Fatalf("full ruleset lacks the DNAT:\n%s", full)
	}
}

func TestNATPreroutingUpdate_portMapClosesThePublicPort(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{{
		Proto: "tcp", Ports: []string{"443"}, TargetIP: "10.100.0.2",
		PortMaps: []config.PortMap{{Public: "443", Internal: "8443"}},
	}}
	s, err := NATPreroutingUpdate(c, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	rules := preroutingOf(t, s)
	if !strings.Contains(rules, `tcp dport { 443 } drop comment "evuproxy-paused:0"`) || strings.Contains(rules, "8443") {
		t.Fatalf("wrong rules for a mapped port:\n%s", rules)
	}
}

func TestNATPreroutingUpdate_dropCounter(t *testing.T) {
	c := pausedTestConfig()
	c.Stats.DropCounters = true
	s, err := NATPreroutingUpdate(c, []int{1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, `tcp dport { 8443, 9000-9001 } counter drop comment "evuproxy-paused:1"`) {
		t.Fatalf("no counter on the drop:\n%s", s)
	}
}

func TestNATPreroutingUpdate_rendersNoMarkerForARouteWithoutRules(t *testing.T) {
	c := pausedTestConfig()
	c.Forwarding.MaintenanceMode = true
	s, err := NATPreroutingUpdate(c, []int{1})
	if err != nil {
		t.Fatal(err)
	}
	if got := PausedRoutesIn(s); len(got) != 0 {
		t.Fatalf("maintenance mode marks %v as paused:\n%s", got, s)
	}
}

func TestPausedRoutesIn_readsNftListOutput(t *testing.T) {
	listing := `table ip evuproxy {
	chain prerouting {
		type nat hook prerouting priority dstnat; policy accept;
		tcp dport 25565 dnat to 10.100.0.2:25565
		tcp dport { 8443, 9000-9001 } drop comment "evuproxy-paused:3"
		udp dport { 8443, 9000-9001 } counter packets 4 bytes 120 drop comment "evuproxy-paused:3"
		tcp dport 80 drop comment "evuproxy-paused:1"
	}
}
`
	if got := PausedRoutesIn(listing); !slices.Equal(got, []int{1, 3}) {
		t.Fatalf("PausedRoutesIn = %v", got)
	}
}

// The update runs `nft -c` after the ruleset it goes over, since it uses that ruleset's table and
// sets, across the features whose rules it can replace.
func TestNATPreroutingUpdate_nftCheck(t *testing.T) {
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("nft not in PATH")
	}
	cases := []struct {
		name string
		mut  func(c *config.Config)
	}{
		{"basic", func(*config.Config) {}},
		{"geo_allow", func(c *config.Config) {
			c.Geo = config.Geo{Enabled: true, Mode: "allow", SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z", BreakGlassCIDRs: []string{"203.0.113.0/24"}}
		}},
		{"geo_block", func(c *config.Config) {
			c.Geo = config.Geo{Enabled: true, Mode: "block", SetName: "geo_v4", Countries: []string{"ru"}, ZoneDir: "/z"}
		}},
		{"deny_and_allow_lists", func(c *config.Config) {
			c.Forwarding.SourceDenyCIDRs = []string{"198.51.100.0/24"}
			c.Forwarding.Routes[0].SourceAllowCIDRs = []string{"203.0.113.0/24"}
			c.Forwarding.Routes[1].SourceDenyCIDRs = []string{"192.0.2.0/24"}
		}},
		{"drop_counters", func(c *config.Config) { c.Stats.DropCounters = true }},
	}
	for _, tc := range cases {
		for _, paused := range [][]int{nil, {1}, {0, 1}} {
			t.Run(tc.name, func(t *testing.T) {
				c := pausedTestConfig()
				tc.mut(c)
				full, err := NFTables(c)
				if err != nil {
					t.Fatal(err)
				}
				update, err := NATPreroutingUpdate(c, paused)
				if err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(t.TempDir(), "check.nft")
				if err := os.WriteFile(path, []byte(full+"\n"+update), 0o644); err != nil {
					t.Fatal(err)
				}
				out, err := exec.Command("nft", "-c", "-f", path).CombinedOutput()
				if err != nil && (strings.Contains(string(out), "syntax error") || !strings.Contains(string(out), "netlink")) {
					t.Fatalf("nft -c: %v\n%s\nruleset:\n%s\n%s", err, out, full, update)
				}
			})
		}
	}
}
