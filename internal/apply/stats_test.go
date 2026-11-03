package apply

import (
	"errors"
	"testing"
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

func TestParseNFTCounterLines_noCounters(t *testing.T) {
	if got := parseNFTCounterLines("ip", "evuproxy", "table ip evuproxy {\n\ttcp dport 22 drop # handle 2\n}\n"); len(got) != 0 {
		t.Fatalf("got %+v", got)
	}
}
