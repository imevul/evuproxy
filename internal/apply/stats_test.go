package apply

import (
	"errors"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestParseNFTCounterLines(t *testing.T) {
	listing := `table inet evuproxy { # handle 7
	set crowdsec_block_v4 { # handle 3
		type ipv4_addr
	}

	chain input { # handle 9
		type filter hook input priority filter; policy drop;
		ct state established,related accept # handle 10
		ip saddr @crowdsec_block_v4 tcp dport 25565 counter packets 12 bytes 720 log prefix "evuproxy-crowdsec: " drop # handle 11
		tcp dport 25565 ip saddr != @geo_v4 counter packets 0 bytes 0 limit rate 5/minute burst 20 packets log prefix "evuproxy-geo-block: " drop # handle 12
		tcp dport 25565 accept # handle 13
	}
}
`
	got := parseNFTCounterLines("inet", "evuproxy", listing)
	if len(got) != 2 {
		t.Fatalf("want the 2 counter rules, got %+v", got)
	}
	if got[0].Packets != 12 || got[0].Bytes != 720 || got[0].Family != "inet" || got[0].Table != "evuproxy" {
		t.Fatalf("first rule: %+v", got[0])
	}
	if got[1].Packets != 0 || got[1].Bytes != 0 {
		t.Fatalf("a rule that has not fired must still be listed: %+v", got[1])
	}
}

// nft rejects options after the command, so -a must come first (or Stats silently stays empty).
func TestNFTCounterLines_optionsBeforeCommand(t *testing.T) {
	f := &fakeRunner{handler: func(name string, args []string) ([]byte, error) {
		if len(args) == 0 || args[0] != "-a" {
			return nil, errors.New("syntax error, options must be specified before commands")
		}
		return []byte("tcp dport 22 counter packets 3 bytes 180 drop # handle 2\n"), nil
	}}
	prev := runner
	runner = f
	t.Cleanup(func() { runner = prev })

	got := nftCounterLines("inet", "evuproxy")
	if len(got) != 1 || got[0].Packets != 3 {
		t.Fatalf("got %+v from calls %v", got, f.calls)
	}
}

const routeAcceptedListing = `table inet evuproxy {
	chain route_accepted {
		type filter hook forward priority 10; policy accept;
		iifname "eth0" oifname "evuproxy0" ip daddr 10.100.0.2 tcp dport 18080 ct original proto-dst 18080 counter packets 12 bytes 720 comment "evuproxy-accepted route=0 proto=tcp"
		iifname "eth0" oifname "evuproxy0" ip daddr 10.100.0.2 tcp dport 18080 ct original proto-dst 18082 counter packets 3 bytes 180 comment "evuproxy-accepted route=1 proto=tcp"
		iifname "eth0" oifname "evuproxy0" ip daddr 10.100.0.3 tcp dport 19000 ct original proto-dst 19000 counter packets 5 bytes 300 comment "evuproxy-accepted route=3 proto=tcp"
		iifname "eth0" oifname "evuproxy0" ip daddr 10.100.0.3 udp dport 19000 ct original proto-dst 19000 counter packets 0 bytes 0 comment "evuproxy-accepted route=3 proto=udp"
	}
}
`

func routeAcceptedConfig() *config.Config {
	return &config.Config{Forwarding: config.Forwarding{Routes: []config.ForwardRoute{
		{Name: "game", Proto: "tcp", Ports: []string{"18080"}, TargetIP: "10.100.0.2"},
		{Proto: "tcp", Ports: []string{"18082"}, TargetIP: "10.100.0.2"},
		{Proto: "udp", Ports: []string{"15353"}, TargetIP: "10.100.0.2", Disabled: true},
		{Proto: "both", Ports: []string{"19000"}, TargetIP: " 10.100.0.3 "},
	}}}
}

func TestParseRouteAccepted(t *testing.T) {
	got := parseRouteAccepted(routeAcceptedConfig(), routeAcceptedListing)
	want := []RouteAcceptedCounter{
		{RouteIndex: 0, Name: "game", Proto: "tcp", Ports: []string{"18080"}, TargetIP: "10.100.0.2", Packets: 12, Bytes: 720},
		{RouteIndex: 1, Proto: "tcp", Ports: []string{"18082"}, TargetIP: "10.100.0.2", Packets: 3, Bytes: 180},
		{RouteIndex: 3, Proto: "tcp", Ports: []string{"19000"}, TargetIP: "10.100.0.3", Packets: 5, Bytes: 300},
		{RouteIndex: 3, Proto: "udp", Ports: []string{"19000"}, TargetIP: "10.100.0.3"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %+v\nwant %+v", got, want)
	}
}

// A failed Apply can leave the live rules and the applied config apart.
func TestParseRouteAccepted_skipsRulesThatDontFitTheConfig(t *testing.T) {
	c := routeAcceptedConfig()
	c.Forwarding.Routes = c.Forwarding.Routes[:1]
	if got := parseRouteAccepted(c, routeAcceptedListing); len(got) != 1 || got[0].RouteIndex != 0 {
		t.Fatalf("index past the end of the routes: %+v", got)
	}

	c = routeAcceptedConfig()
	c.Forwarding.Routes[0].TargetIP = "10.100.0.9"
	c.Forwarding.Routes[1].Proto = "udp"
	got := parseRouteAccepted(c, routeAcceptedListing)
	if len(got) != 2 || got[0].RouteIndex != 3 || got[1].RouteIndex != 3 {
		t.Fatalf("moved target or changed proto: %+v", got)
	}

	// 10.100.0.2 must not pass for 10.100.0.20.
	c = routeAcceptedConfig()
	c.Forwarding.Routes[0].TargetIP = "10.100.0.20"
	for _, r := range parseRouteAccepted(c, routeAcceptedListing) {
		if r.RouteIndex == 0 {
			t.Fatalf("prefix of the target matched: %+v", r)
		}
	}
}

func TestParseRouteAccepted_empty(t *testing.T) {
	got := parseRouteAccepted(routeAcceptedConfig(), "")
	if got == nil || len(got) != 0 {
		t.Fatalf("want an empty list, not null: %#v", got)
	}
}

// The Stats table is for stats.drop_counters. These would stop its empty state from showing.
func TestParseNFTCounterLines_leavesOutRouteAccepted(t *testing.T) {
	if got := parseNFTCounterLines("inet", "evuproxy", routeAcceptedListing); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}

func TestRouteAcceptedCounters_noAppliedConfig(t *testing.T) {
	got := routeAcceptedCounters(filepath.Join(t.TempDir(), "config.yaml"))
	if got == nil || len(got) != 0 {
		t.Fatalf("want an empty list, not null: %#v", got)
	}
}

func TestParseNFTCounterLines_noCounters(t *testing.T) {
	if got := parseNFTCounterLines("ip", "evuproxy", "table ip evuproxy {\n\ttcp dport 22 drop # handle 2\n}\n"); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}
