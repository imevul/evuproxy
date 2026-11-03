package apply

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestInputAllowLockoutWarnings(t *testing.T) {
	const connPort = 8443
	ssh := config.AllowRule{Proto: "tcp", DPort: "22", Note: "SSH"}
	ui := config.AllowRule{Proto: "tcp", DPort: "9080", Note: "UI"}
	conn := config.AllowRule{Proto: "tcp", DPort: "8443", Note: "connection"}
	web := config.AllowRule{Proto: "tcp", DPort: "{80,443}", Note: "web"}
	disabled := func(r config.AllowRule) config.AllowRule {
		r.Disabled = true
		return r
	}
	applied := []config.AllowRule{ssh, ui, conn, web}

	tests := []struct {
		name     string
		applied  []config.AllowRule
		rules    []config.AllowRule
		admin    []int
		connPort int
		want     []string // substrings of the expected warnings, in order
	}{
		{name: "unchanged", applied: applied, rules: applied, connPort: connPort},
		{name: "disable SSH", applied: applied, rules: []config.AllowRule{disabled(ssh), ui, conn, web}, connPort: connPort, want: []string{"TCP port 22 (SSH)"}},
		{name: "remove SSH", applied: applied, rules: []config.AllowRule{ui, conn, web}, connPort: connPort, want: []string{"TCP port 22 (SSH)"}},
		{name: "disable UI", applied: applied, rules: []config.AllowRule{ssh, disabled(ui), conn, web}, connPort: connPort, want: []string{"TCP port 9080 (admin UI)"}},
		{name: "remove UI", applied: applied, rules: []config.AllowRule{ssh, conn, web}, connPort: connPort, want: []string{"TCP port 9080 (admin UI)"}},
		{name: "disable current connection", applied: applied, rules: []config.AllowRule{ssh, ui, disabled(conn), web}, connPort: connPort, want: []string{"TCP port 8443 (your current connection)"}},
		{name: "remove current connection", applied: applied, rules: []config.AllowRule{ssh, ui, web}, connPort: connPort, want: []string{"TCP port 8443 (your current connection)"}},
		{name: "disable unrelated", applied: applied, rules: []config.AllowRule{ssh, ui, conn, disabled(web)}, connPort: connPort},
		{name: "remove unrelated", applied: applied, rules: []config.AllowRule{ssh, ui, conn}, connPort: connPort},
		{
			name:     "connection on the SSH port is one warning",
			applied:  applied,
			rules:    []config.AllowRule{ui, conn, web},
			connPort: 22,
			want:     []string{"TCP port 22 (SSH, your current connection)"},
		},
		{
			name:    "port dropped from a list",
			applied: []config.AllowRule{{Proto: "tcp", DPort: "{ 22, 443 }"}, ui},
			rules:   []config.AllowRule{{Proto: "tcp", DPort: "{ 443 }"}, ui},
			want:    []string{"TCP port 22 (SSH)"},
		},
		{
			name:    "UDP rule does not keep SSH open",
			applied: applied,
			rules:   []config.AllowRule{{Proto: "udp", DPort: "22"}, ui, conn, web},
			want:    []string{"TCP port 22 (SSH)"},
		},
		{name: "still covered by a range", applied: applied, rules: []config.AllowRule{{Proto: "tcp", DPort: "20-30"}, ui}},
		{name: "still covered by a list", applied: applied, rules: []config.AllowRule{{Proto: "tcp", DPort: "{22, 9080}"}}},
		{name: "still covered by admin_tcp_ports", applied: applied, rules: []config.AllowRule{ui}, admin: []int{22}},
		{name: "another enabled rule still covers it", applied: []config.AllowRule{ssh, ssh, ui}, rules: []config.AllowRule{disabled(ssh), ssh, ui}},
		{
			name:    "already disabled when applied",
			applied: []config.AllowRule{disabled(ssh), ui},
			rules:   []config.AllowRule{disabled(ssh), ui},
		},
		{
			name:    "host without a UI rule does not warn on every apply",
			applied: []config.AllowRule{ssh},
			rules:   []config.AllowRule{ssh},
		},
		{
			name:  "nothing applied yet assumes the ports are in use",
			rules: []config.AllowRule{web},
			want:  []string{"TCP port 22 (SSH)", "TCP port 9080 (admin UI)"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var base *config.Config
			if tt.applied != nil {
				base = &config.Config{InputAllows: tt.applied}
			}
			c := &config.Config{InputAllows: tt.rules, Network: config.Network{AdminTCPPorts: tt.admin}}
			got := InputAllowLockoutWarnings(c, base, tt.connPort)
			if len(got) != len(tt.want) {
				t.Fatalf("got %+v, want %q", got, tt.want)
			}
			for i, w := range got {
				if w.Code != "lockout_risk_input_allows" || !strings.Contains(w.Message, tt.want[i]) {
					t.Fatalf("warning %d: got %+v, want %q", i, w, tt.want[i])
				}
			}
		})
	}
}

// The gate only sees what ValidateConfigWithWarnings returns, and the check does not
// depend on the client address, so it must also run for clients with no detected IP.
func TestValidateConfigWithWarnings_inputAllowRisk(t *testing.T) {
	c := validTestConfig(t)
	c.InputAllows = []config.AllowRule{{Proto: "tcp", DPort: "9080"}}
	applied := validTestConfig(t)
	applied.InputAllows = []config.AllowRule{{Proto: "tcp", DPort: "22"}, {Proto: "tcp", DPort: "9080"}}
	res := ValidateConfigWithWarnings(c, applied, ClientIPInfo{Source: ClientIPSourceUnavailable}, nil, false)
	found := false
	for _, w := range res.Warnings {
		if w.Code == "lockout_risk_input_allows" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected lockout_risk_input_allows, got %+v", res.Warnings)
	}
}

func TestLoadAppliedConfig(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "config.yaml")
	if LoadAppliedConfig(cfgPath) != nil {
		t.Fatal("no snapshot must load as nil")
	}
	if err := os.WriteFile(cfgPath+".bak", []byte("not: [valid"), 0o644); err != nil {
		t.Fatal(err)
	}
	if LoadAppliedConfig(cfgPath) != nil {
		t.Fatal("unreadable snapshot must load as nil")
	}
}

func TestLockoutWarnings_maintenance(t *testing.T) {
	c := &config.Config{
		WireGuard:  config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:    config.Network{PublicInterface: "eth0"},
		Geo:        config.Geo{Enabled: false},
		Forwarding: config.Forwarding{MaintenanceMode: true},
		Peers:      []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	if len(w) != 1 || w[0].Code != "lockout_risk_maintenance" {
		t.Fatalf("got %+v", w)
	}
}

func TestLockoutWarnings_sourceDeny(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Geo:       config.Geo{Enabled: false},
		Forwarding: config.Forwarding{
			SourceDenyCIDRs: []string{"203.0.113.0/24"},
			Routes:          []config.ForwardRoute{{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"}},
		},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	found := false
	for _, x := range w {
		if x.Code == "lockout_risk_source_deny" {
			found = true
		}
	}
	if !found {
		t.Fatalf("got %+v", w)
	}
}

func TestLockoutWarnings_sourceAllow(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24"},
		Network:   config.Network{PublicInterface: "eth0"},
		Geo:       config.Geo{Enabled: false},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{{
				Proto:            "tcp",
				Ports:            []string{"25565"},
				TargetIP:         "10.100.0.2",
				SourceAllowCIDRs: []string{"198.51.100.0/24"},
			}},
		},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	w := LockoutWarnings(c, "203.0.113.5", nil)
	found := false
	for _, x := range w {
		if x.Code == "lockout_risk_source_allow" {
			found = true
		}
	}
	if !found {
		t.Fatalf("got %+v", w)
	}
}
