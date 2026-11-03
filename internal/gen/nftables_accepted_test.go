package gen

import (
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

// chainOf returns the text of one chain in a rendered ruleset.
func chainOf(t *testing.T, s, name string) string {
	t.Helper()
	_, rest, ok := strings.Cut(s, "chain "+name+" {")
	if !ok {
		t.Fatalf("no chain %s in:\n%s", name, s)
	}
	body, _, ok := strings.Cut(rest, "\n    }")
	if !ok {
		t.Fatalf("chain %s isn't closed in:\n%s", name, s)
	}
	return body
}

func acceptedTestConfig() *config.Config {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"18080"}, TargetIP: "10.100.0.2"},
		{Proto: "tcp", Ports: []string{"18082"}, TargetIP: "10.100.0.2", PortMaps: []config.PortMap{{Public: "18082", Internal: "18080"}}},
		{Proto: "udp", Ports: []string{"15353"}, TargetIP: "10.100.0.2", Disabled: true},
		{Proto: "both", Ports: []string{"19000-19002"}, TargetIP: "10.100.0.3"},
	}
	return c
}

func TestNFTables_routeAccepted_oneCounterPerRouteAndProto(t *testing.T) {
	s, err := NFTables(acceptedTestConfig())
	if err != nil {
		t.Fatal(err)
	}
	chain := chainOf(t, s, RouteAcceptedChain)
	for _, want := range []string{
		`iifname "eth0" oifname "wg0" ip daddr 10.100.0.2 tcp dport { 18080 } ct original proto-dst { 18080 } counter comment "evuproxy-accepted route=0 proto=tcp"`,
		`iifname "eth0" oifname "wg0" ip daddr 10.100.0.2 tcp dport { 18080 } ct original proto-dst { 18082 } counter comment "evuproxy-accepted route=1 proto=tcp"`,
		`iifname "eth0" oifname "wg0" ip daddr 10.100.0.3 tcp dport { 19000-19002 } ct original proto-dst { 19000-19002 } counter comment "evuproxy-accepted route=3 proto=tcp"`,
		`iifname "eth0" oifname "wg0" ip daddr 10.100.0.3 udp dport { 19000-19002 } ct original proto-dst { 19000-19002 } counter comment "evuproxy-accepted route=3 proto=udp"`,
	} {
		if !strings.Contains(chain, want) {
			t.Errorf("missing %q in:\n%s", want, chain)
		}
	}
	if got := strings.Count(chain, " counter "); got != 4 {
		t.Errorf("want 4 counters, the disabled route has none, got %d:\n%s", got, chain)
	}
}

// Two routes share a target and an internal port here, and only the public port tells their
// packets apart. Without it, every packet of the mapped route would count on both.
func TestNFTables_routeAccepted_sharedTargetAndInternalPortStaySeparate(t *testing.T) {
	s, err := NFTables(acceptedTestConfig())
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(chainOf(t, s, RouteAcceptedChain), "\n") {
		if strings.Contains(line, " counter ") && !strings.Contains(line, "ct original proto-dst") {
			t.Errorf("rule doesn't pin the public port: %q", line)
		}
	}
}

// The chain only counts what the forward chain let through, so what keeps dropped traffic out is
// that it runs later and that the established accept and every drop stay in the forward chain.
func TestNFTables_routeAccepted_runsAfterEveryDrop(t *testing.T) {
	c := acceptedTestConfig()
	c.Stats.DropCounters = true
	c.CrowdSec.Enabled = true
	c.Geo = config.Geo{Enabled: true, Mode: "allow", SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"}
	c.Forwarding.SourceDenyCIDRs = []string{"192.0.2.0/24"}
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 5, UDPPerSecond: 5, MaxConnPerIP: 5}
	c.Forwarding.Routes[0].SourceDenyCIDRs = []string{"198.51.100.0/24"}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}

	chain := chainOf(t, s, RouteAcceptedChain)
	if !strings.Contains(chain, "type filter hook forward priority 10; policy accept;") {
		t.Fatalf("must run after the forward chain, and must never decide a packet's fate:\n%s", chain)
	}
	if !strings.Contains(chainOf(t, s, "forward"), "type filter hook forward priority 0; policy drop;") {
		t.Fatal("forward chain priority changed, so check it still runs before route_accepted")
	}
	for _, unwanted := range []string{"drop", "accept\n", "@", "ct state", "limit"} {
		if strings.Contains(chain, unwanted) {
			t.Errorf("chain must only match on the route and count, found %q:\n%s", unwanted, chain)
		}
	}

	forward := chainOf(t, s, "forward")
	for _, drop := range []string{"@crowdsec_block_v4", "@global_src_deny_v4", "@route_deny_0", "@ratelimit_syn_v4", "@ratelimit_udp_v4", "@ratelimit_conn_r0_tcp"} {
		if !strings.Contains(forward, drop) {
			t.Errorf("forward chain lacks %s:\n%s", drop, forward)
		}
	}
	if strings.Contains(forward, routeAcceptedCommentPrefix) {
		t.Errorf("forward chain must not count accepted traffic:\n%s", forward)
	}
}

// Reading the counters only stays cheap while their table has no sets for nft to load.
func TestNFTables_routeAccepted_tableHasNoSets(t *testing.T) {
	c := acceptedTestConfig()
	c.CrowdSec.Enabled = true
	c.Geo = config.Geo{Enabled: true, Mode: "allow", SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	_, table, ok := strings.Cut(s, "table inet "+RouteAcceptedTable+" {")
	if !ok {
		t.Fatalf("no table %s in:\n%s", RouteAcceptedTable, s)
	}
	for _, unwanted := range []string{"set ", "map ", "@"} {
		if strings.Contains(table, unwanted) {
			t.Errorf("found %q in:\n%s", unwanted, table)
		}
	}
	_, filter, _ := strings.Cut(s, "table inet evuproxy {")
	filter, _, _ = strings.Cut(filter, "\nadd table ip evuproxy")
	if strings.Contains(filter, RouteAcceptedChain) {
		t.Errorf("the chain must only be in its own table:\n%s", filter)
	}
}

func TestNFTables_routeAccepted_noChainWithoutRoutes(t *testing.T) {
	c := baseNFTConfig()
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, RouteAcceptedChain) {
		t.Fatalf("no routes need no chain:\n%s", s)
	}
	// An Apply that leaves no routes still has to remove the rules of the last one.
	replace := "add table inet " + RouteAcceptedTable + "\ndelete table inet " + RouteAcceptedTable + "\n"
	if !strings.Contains(s, replace) {
		t.Fatalf("missing %q in:\n%s", replace, s)
	}
	nftCheck(t, c)

	c = acceptedTestConfig()
	c.Forwarding.MaintenanceMode = true
	s, err = NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, RouteAcceptedChain) {
		t.Fatalf("maintenance mode forwards nothing, so it needs no chain:\n%s", s)
	}
}

func TestNFTables_routeAccepted_ruleset(t *testing.T) {
	c := acceptedTestConfig()
	c.CrowdSec.Enabled = true
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 5, UDPPerSecond: 5}
	nftCheck(t, c)
}

// A pause only replaces prerouting, so the counts have to survive it.
func TestNATPreroutingUpdate_leavesRouteAcceptedAlone(t *testing.T) {
	c := acceptedTestConfig()
	update, err := NATPreroutingUpdate(c, []int{0})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(update, RouteAcceptedChain) || strings.Contains(update, RouteAcceptedTable) || strings.Contains(update, "inet evuproxy") {
		t.Fatalf("pause update must not touch the filter table:\n%s", update)
	}
}

func TestParseRouteAcceptedComment(t *testing.T) {
	cases := []struct {
		line  string
		index int
		proto string
		ok    bool
	}{
		{`ip daddr 10.100.0.2 counter packets 1 bytes 2 comment "evuproxy-accepted route=12 proto=udp" # handle 3`, 12, "udp", true},
		{`ip daddr 10.100.0.2 counter comment "` + routeAcceptedComment(0, "tcp") + `"`, 0, "tcp", true},
		{`tcp dport 22 counter packets 1 bytes 2 drop # handle 3`, 0, "", false},
		{`counter packets 1 bytes 2 comment "other route=1 proto=tcp"`, 0, "", false},
		{`counter packets 1 bytes 2 comment "evuproxy-accepted route=x proto=tcp"`, 0, "", false},
		{`counter packets 1 bytes 2 comment "evuproxy-accepted route=99999999999999999999 proto=tcp"`, 0, "", false},
	}
	for _, tc := range cases {
		i, proto, ok := ParseRouteAcceptedComment(tc.line)
		if i != tc.index || proto != tc.proto || ok != tc.ok {
			t.Errorf("%q: got %d %q %v", tc.line, i, proto, ok)
		}
	}
}
