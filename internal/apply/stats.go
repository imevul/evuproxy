package apply

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// Stats bundles observability data for the admin UI.
type Stats struct {
	WireGuardInterface string           `json:"wireguard_interface"`
	WireGuardPeers     []WGPeerDump     `json:"wireguard_peers"`
	NFTables           []NFTCounterLine `json:"nftables_counters"`
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

// NFTCounterLine is a ruleset line that includes an nft counter.
type NFTCounterLine struct {
	Family  string `json:"family"`
	Table   string `json:"table"`
	Line    string `json:"line"`
	Packets uint64 `json:"packets"`
	Bytes   uint64 `json:"bytes"`
}

var nftCounterRE = regexp.MustCompile(`counter\s+packets\s+(\d+)\s+bytes\s+(\d+)`)

// StatsFromHost collects wg + nft counter snippets. Commands may fail on a dev machine without wg/nft.
func StatsFromHost(cfgPath string) (*Stats, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	st := &Stats{WireGuardInterface: c.WireGuard.Interface}
	st.WireGuardPeers, _ = wgDumpPeers(c.WireGuard.Interface)
	st.NFTables = append(st.NFTables, nftCounterLines("inet", "evuproxy")...)
	st.NFTables = append(st.NFTables, nftCounterLines("ip", "evuproxy")...)
	return st, nil
}

func wgDumpPeers(iface string) ([]WGPeerDump, error) {
	out, err := exec.Command("wg", "show", iface, "dump").Output()
	if err != nil {
		return nil, err
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) < 2 {
		return nil, nil
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
	out, err := exec.Command("nft", "list", "table", family, table, "-a").CombinedOutput()
	if err != nil {
		return nil
	}
	var res []NFTCounterLine
	for _, line := range strings.Split(string(out), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || !strings.Contains(line, "counter") {
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
