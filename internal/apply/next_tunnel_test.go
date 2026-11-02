package apply

import (
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestNextFreeTunnelIP(t *testing.T) {
	tests := []struct {
		name          string
		serverAddress string
		peers         []config.Peer
		want          string
	}{
		{"skips the server address", "10.100.0.1/24", nil, "10.100.0.2/32"},
		{"server elsewhere leaves the first host free", "10.100.0.5/24", nil, "10.100.0.1/32"},
		{
			"skips enabled peers",
			"10.100.0.1/24",
			[]config.Peer{{Name: "a", TunnelIP: "10.100.0.2/32"}, {Name: "b", TunnelIP: "10.100.0.3/32"}},
			"10.100.0.4/32",
		},
		{
			"reuses the address of a disabled peer",
			"10.100.0.1/24",
			[]config.Peer{{Name: "a", TunnelIP: "10.100.0.2/32", Disabled: true}},
			"10.100.0.2/32",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			c := &config.Config{WireGuard: config.WireGuard{Address: tc.serverAddress}, Peers: tc.peers}
			got, err := NextFreeTunnelIP(filepath.Join(t.TempDir(), "config.yaml"), c)
			if err != nil {
				t.Fatal(err)
			}
			if got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
