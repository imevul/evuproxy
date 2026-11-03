package apply

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

// Stats bundles observability data for the admin UI.
type Stats struct {
	WireGuardInterface string `json:"wireguard_interface"`
	// WireGuardDumpFailed is true when `wg show` could not be read (interface missing, permission, etc.).
	// When false and WireGuardPeers is empty, the interface has no peer rows (e.g. no peers configured).
	WireGuardDumpFailed bool             `json:"wireguard_dump_failed,omitempty"`
	WireGuardPeers      []WGPeerDump     `json:"wireguard_peers"`
	NFTables            []NFTCounterLine `json:"nftables_counters"`
	// RouteAccepted is never null: no live rules gives an empty list.
	RouteAccepted []RouteAcceptedCounter `json:"route_accepted"`
}

// RouteAcceptedCounter is the traffic the firewall accepted for one route and protocol since the
// last Apply. It is accepted traffic, not players or legitimate clients: see docs/http-api.md.
type RouteAcceptedCounter struct {
	// RouteIndex is the route's position in forwarding.routes of the applied config.
	RouteIndex int      `json:"route_index"`
	Name       string   `json:"name,omitempty"`
	Proto      string   `json:"proto"` // tcp or udp, so a route with both has two rows
	Ports      []string `json:"ports"`
	TargetIP   string   `json:"target_ip"`
	Packets    uint64   `json:"packets"`
	Bytes      uint64   `json:"bytes"`
}

// WGPeerDump is one line from `wg show IFACE dump` (peer rows only).
type WGPeerDump struct {
	PublicKey       string `json:"public_key"`
	Endpoint        string `json:"endpoint,omitempty"`
	AllowedIPs      string `json:"allowed_ips,omitempty"`
	LatestHandshake int64  `json:"latest_handshake_unix"`
	TransferRX      int64  `json:"transfer_rx"`
	TransferTX      int64  `json:"transfer_tx"`
}

// NFTCounterLine is a ruleset line that includes an nft counter (see stats.drop_counters).
type NFTCounterLine struct {
	Family  string `json:"family"`
	Table   string `json:"table"`
	Line    string `json:"line"`
	Packets uint64 `json:"packets"`
	Bytes   uint64 `json:"bytes"`
}

var nftCounterRE = regexp.MustCompile(`counter\s+packets\s+(\d+)\s+bytes\s+(\d+)`)

var routeAcceptedPublicPortsRE = regexp.MustCompile(`ct original proto-dst (\{[^}]*\}|\S+)`)

// nft 1.0.6 has no type for the elements of a conntrack port set, so it lists them raw:
// { 0x50 [invalid type], 0x1bb [invalid type] } is { 80, 443 }. nft 1.1.6 lists the numbers.
var nftRawPortRE = regexp.MustCompile(`0x([0-9a-fA-F]+) \[invalid type\]`)

// StatsFromHost collects wg + nft counter snippets. Commands may fail on a dev machine without wg/nft.
func StatsFromHost(cfgPath string) (*Stats, error) {
	st, err := StatsWithoutDropCounters(cfgPath)
	if err != nil {
		return nil, err
	}
	st.NFTables = append(st.NFTables, nftCounterLines("inet", "evuproxy")...)
	st.NFTables = append(st.NFTables, nftCounterLines("ip", "evuproxy")...)
	return st, nil
}

// StatsWithoutDropCounters is StatsFromHost without NFTables, for callers that don't use it. Those
// whole-table listings are the part that grows with the geo sets, on nft older than 1.1.
func StatsWithoutDropCounters(cfgPath string) (*Stats, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	st := &Stats{WireGuardInterface: c.WireGuard.Interface}
	peers, err := wgDumpPeers(c.WireGuard.Interface)
	if err != nil {
		st.WireGuardDumpFailed = true
	} else {
		st.WireGuardPeers = peers
	}
	st.RouteAccepted = RouteAcceptedCounters(cfgPath)
	return st, nil
}

// RouteAcceptedCounters reads the live counters. It describes them from the applied config,
// because the live rules were rendered from that, and the saved one may have moved routes since.
func RouteAcceptedCounters(cfgPath string) []RouteAcceptedCounter {
	c := LoadAppliedConfig(cfgPath)
	if c == nil {
		return []RouteAcceptedCounter{}
	}
	out, err := runCmdCombined(context.Background(), "nft", "list", "chain", "inet", gen.RouteAcceptedTable, gen.RouteAcceptedChain)
	if err != nil {
		return []RouteAcceptedCounter{}
	}
	return parseRouteAccepted(c, string(out))
}

// parseRouteAccepted leaves out a rule that doesn't fit the route its comment names: a failed
// Apply can leave the live rules and the applied config apart, and a missing row is better than
// one route's traffic shown against another.
func parseRouteAccepted(c *config.Config, listing string) []RouteAcceptedCounter {
	res := []RouteAcceptedCounter{}
	for _, line := range strings.Split(listing, "\n") {
		i, proto, ok := gen.ParseRouteAcceptedComment(line)
		if !ok || i >= len(c.Forwarding.Routes) {
			continue
		}
		r := c.Forwarding.Routes[i]
		target := strings.TrimSpace(r.TargetIP)
		protos, err := config.ParseRouteProtocols(r.Proto)
		if err != nil || !slices.Contains(protos, proto) || !strings.Contains(line, "ip daddr "+target+" ") {
			continue
		}
		if !routeAcceptedPortsFit(line, r.Ports) {
			continue
		}
		m := nftCounterRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pk, _ := strconv.ParseUint(m[1], 10, 64)
		bk, _ := strconv.ParseUint(m[2], 10, 64)
		res = append(res, RouteAcceptedCounter{
			RouteIndex: i,
			Name:       r.Name,
			Proto:      proto,
			Ports:      r.Ports,
			TargetIP:   target,
			Packets:    pk,
			Bytes:      bk,
		})
	}
	return res
}

// routeAcceptedPortsFit compares a rule's public ports with a route's. It reads them from the
// conntrack match, because the rule's dport is the internal port on a mapped route.
func routeAcceptedPortsFit(line string, routePorts []string) bool {
	m := routeAcceptedPublicPortsRE.FindStringSubmatch(line)
	if m == nil {
		return false
	}
	expr := nftRawPortRE.ReplaceAllStringFunc(m[1], func(raw string) string {
		p, err := strconv.ParseUint(nftRawPortRE.FindStringSubmatch(raw)[1], 16, 16)
		if err != nil {
			return raw
		}
		return strconv.FormatUint(p, 10)
	})
	live, err := config.ExpandRoutePortNumbers([]string{expr})
	if err != nil {
		return false
	}
	want, err := config.ExpandRoutePortNumbers(routePorts)
	return err == nil && slices.Equal(live, want)
}

// NFTablesChainsForMetrics returns the text of the evuproxy forward and input chains (inet).
func NFTablesChainsForMetrics() (forward, input []byte, err error) {
	fwd, err := runCmdCombined(context.Background(), "nft", "list", "chain", "inet", "evuproxy", "forward")
	if err != nil {
		return fwd, nil, fmt.Errorf("nft forward chain: %w", err)
	}
	inp, err := runCmdCombined(context.Background(), "nft", "list", "chain", "inet", "evuproxy", "input")
	if err != nil {
		return fwd, inp, fmt.Errorf("nft input chain: %w", err)
	}
	return fwd, inp, nil
}

// WireGuardPeers returns the peer rows of `wg show IFACE dump`.
func WireGuardPeers(iface string) ([]WGPeerDump, error) {
	return wgDumpPeers(iface)
}

func wgDumpPeers(iface string) ([]WGPeerDump, error) {
	out, err := runCmdOutput(context.Background(), "wg", "show", iface, "dump")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return []WGPeerDump{}, nil
	}
	var peers []WGPeerDump
	for _, line := range lines[1:] {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		fields := strings.Split(line, "\t")
		if len(fields) < 8 {
			continue
		}
		rx, _ := strconv.ParseInt(fields[5], 10, 64)
		tx, _ := strconv.ParseInt(fields[6], 10, 64)
		hand, _ := strconv.ParseInt(fields[4], 10, 64)
		peers = append(peers, WGPeerDump{
			PublicKey:       fields[0],
			Endpoint:        fields[2],
			AllowedIPs:      fields[3],
			LatestHandshake: hand,
			TransferRX:      rx,
			TransferTX:      tx,
		})
	}
	return peers, nil
}

func nftCounterLines(family, table string) []NFTCounterLine {
	// -t leaves out set contents: no counter line needs them, and printing geo sets is costly.
	out, err := runCmdCombined(context.Background(), "nft", "-a", "-t", "list", "table", family, table)
	if err != nil {
		return nil
	}
	return parseNFTCounterLines(family, table, string(out))
}

func parseNFTCounterLines(family, table, listing string) []NFTCounterLine {
	var res []NFTCounterLine
	for _, line := range strings.Split(listing, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "counter") {
			continue
		}
		// Those are reported per route, and this list is for stats.drop_counters.
		if _, _, accepted := gen.ParseRouteAcceptedComment(line); accepted {
			continue
		}
		m := nftCounterRE.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		pk, _ := strconv.ParseUint(m[1], 10, 64)
		bk, _ := strconv.ParseUint(m[2], 10, 64)
		res = append(res, NFTCounterLine{
			Family:  family,
			Table:   table,
			Line:    line,
			Packets: pk,
			Bytes:   bk,
		})
	}
	return res
}
