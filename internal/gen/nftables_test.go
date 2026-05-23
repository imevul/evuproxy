package gen

import (
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestNFTablesRoutesGeo(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
				{Proto: "udp", Ports: []string{"19132-19133"}, TargetIP: "10.100.0.3"},
			},
		},
		Geo: config.Geo{Enabled: true, SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"},
		Peers: []config.Peer{
			{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"},
			{Name: "b", PublicKey: "y", TunnelIP: "10.100.0.3/32"},
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "dnat to 10.100.0.2") || !strings.Contains(s, "dnat to 10.100.0.3") {
		t.Fatalf("missing dnat: %s", s)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport") {
		t.Fatal("expected geo-wrapped tcp input")
	}
	if strings.Contains(s, "ip saddr @geo_v4 tcp dport { 25565 } limit rate") {
		t.Fatal("did not expect block-style geo on allow mode")
	}
	if !strings.Contains(s, "ip daddr 10.100.0.2 tcp dport") {
		t.Fatal("expected forward tcp rule")
	}
	if !strings.Contains(s, "ip daddr 10.100.0.3 masquerade") {
		t.Fatal("expected masquerade for second target")
	}
}

func TestNFTablesRoutesGeoBlockMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo: config.Geo{Enabled: true, Mode: "block", SetName: "geo_v4", Countries: []string{"ru"}, ZoneDir: "/z"},
		Peers: []config.Peer{
			{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"},
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 25565 drop") {
		t.Fatalf("expected block-first geo drop before dnat: %s", s)
	}
	if !strings.Contains(s, "tcp dport 25565 dnat to 10.100.0.2") {
		t.Fatal("expected dnat after block rule")
	}
}

func TestNFTablesAdminTCPPortsDisabled(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0", AdminTCPPorts: []int{}},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "tcp dport 9080 accept") {
		t.Fatalf("expected no default admin port when admin_tcp_ports is empty: %s", s)
	}
}

func TestNFTablesRoutesBothProtosOneRoute(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp,udp", Ports: []string{"19132"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 19132 dnat to 10.100.0.2") {
		t.Fatalf("missing tcp dnat: %s", s)
	}
	if !strings.Contains(s, "udp dport 19132 dnat to 10.100.0.2") {
		t.Fatalf("missing udp dnat: %s", s)
	}
}

func TestNFTablesSkipsDisabledRoute(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
				{Proto: "tcp", Ports: []string{"9999"}, TargetIP: "10.100.0.2", Disabled: true},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "9999") {
		t.Fatalf("disabled route must not appear in nftables: %s", s)
	}
	if !strings.Contains(s, "tcp dport { 80 }") {
		t.Fatalf("enabled route must appear: %s", s)
	}
}

func TestNFTablesSkipsDisabledInputAllow(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "22"},
			{Proto: "tcp", DPort: "9999", Disabled: true},
		},
		Geo: config.Geo{Enabled: false},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 22 accept") {
		t.Fatalf("enabled input_allow must appear: %s", s)
	}
	if strings.Contains(s, "tcp dport 9999 accept") {
		t.Fatalf("disabled input_allow must not appear in nftables: %s", s)
	}
}

func TestNFTablesInputAllowsUnfilteredWhenGeoApplyOff(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{Enabled: true, SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 2222 accept") {
		t.Fatalf("input_allow must be plain accept when apply_to_input_allows is false: %s", s)
	}
	if strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222") {
		t.Fatalf("did not expect geo on input_allow 2222: %s", s)
	}
}

func TestNFTablesInputAllowsGeoAllowMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{
			Enabled:            true,
			SetName:            "geo_v4",
			Countries:          []string{"no"},
			ZoneDir:            "/z",
			ApplyToInputAllows: true,
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222 accept") {
		t.Fatalf("expected geo allow on input 2222: %s", s)
	}
	if !strings.Contains(s, "tcp dport 2222 ip saddr != @geo_v4") {
		t.Fatalf("expected geo drop for non-set on input 2222: %s", s)
	}
}

func TestNFTablesInputAllowsGeoBlockMode(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		InputAllows: []config.AllowRule{
			{Proto: "tcp", DPort: "2222"},
		},
		Geo: config.Geo{
			Enabled:            true,
			Mode:               "block",
			SetName:            "geo_v4",
			Countries:          []string{"ru"},
			ZoneDir:            "/z",
			ApplyToInputAllows: true,
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 2222 limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop") {
		t.Fatalf("expected block-list geo drop on input 2222: %s", s)
	}
	if !strings.Contains(s, "tcp dport 2222 accept") {
		t.Fatalf("expected accept after block rule for input 2222: %s", s)
	}
}

func TestNFTablesForwardAllowDockerBridges(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{
			PublicInterface:           "eth0",
			ForwardAllowDockerBridges: true,
			ForwardExtraLocalCIDRs:    []string{"10.89.0.0/24"},
		},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 172.16.0.0/12 accept") {
		t.Fatalf("expected docker bridge ingress allow: %s", s)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 192.168.0.0/16 accept") {
		t.Fatalf("expected 192.168 ingress allow: %s", s)
	}
	if !strings.Contains(s, "iifname \"eth0\" oifname != \"wg0\" ip daddr 10.89.0.0/24 accept") {
		t.Fatalf("expected extra CIDR ingress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 172.16.0.0/12 oifname \"eth0\" accept") {
		t.Fatalf("expected docker bridge egress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 192.168.0.0/16 oifname \"eth0\" accept") {
		t.Fatalf("expected 192.168 egress allow: %s", s)
	}
	if !strings.Contains(s, "ip saddr 10.89.0.0/24 oifname \"eth0\" accept") {
		t.Fatalf("expected extra CIDR egress allow: %s", s)
	}
}

func TestNFTablesAdminTCPPortsExplicit(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0", AdminTCPPorts: []int{8443}},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 8443 accept") {
		t.Fatalf("expected explicit admin_tcp_ports on INPUT: %s", s)
	}
}

func TestNFTablesRouteSourceAllowlist(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{
					Proto:            "tcp",
					Ports:            []string{"25565"},
					TargetIP:         "10.100.0.2",
					SourceAllowCIDRs: []string{"203.0.113.0/24", "198.51.100.1"},
				},
			},
		},
		Geo:   config.Geo{Enabled: false},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "set route_src_0 {") || !strings.Contains(s, "203.0.113.0/24") {
		t.Fatalf("expected route source set: %s", s)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 ip daddr 10.100.0.2 tcp dport { 25565 } accept") {
		t.Fatalf("expected forward rule with source set: %s", s)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 tcp dport 25565 dnat to 10.100.0.2") {
		t.Fatalf("expected dnat with source set: %s", s)
	}
}

func TestNFTablesRouteSourceAllowlistGeoAllow(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{
					Proto:            "tcp",
					Ports:            []string{"443"},
					TargetIP:         "10.100.0.2",
					SourceAllowCIDRs: []string{"10.0.0.0/8"},
				},
			},
		},
		Geo:   config.Geo{Enabled: true, SetName: "geo_v4", Countries: []string{"no"}, ZoneDir: "/z"},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 ip saddr @geo_v4 tcp dport { 443 } accept") {
		t.Fatalf("expected geo+source on input: %s", s)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 ip saddr @geo_v4 tcp dport 443 dnat to 10.100.0.2") {
		t.Fatalf("expected geo+source on dnat: %s", s)
	}
}

func TestNFTablesRouteSourceAllowlistGeoBlock(t *testing.T) {
	c := &config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51830,
			PrivateKeyFile: "/k",
			Address:        "10.100.0.1/24",
		},
		Network: config.Network{PublicInterface: "eth0"},
		Forwarding: config.Forwarding{
			Routes: []config.ForwardRoute{
				{
					Proto:            "tcp",
					Ports:            []string{"443"},
					TargetIP:         "10.100.0.2",
					SourceAllowCIDRs: []string{"203.0.113.0/24"},
				},
			},
		},
		Geo:   config.Geo{Enabled: true, Mode: "block", SetName: "geo_v4", Countries: []string{"ru"}, ZoneDir: "/z"},
		Peers: []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport 443 drop") {
		t.Fatalf("expected geo block drop on dnat chain: %s", s)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 tcp dport 443 dnat to 10.100.0.2") {
		t.Fatalf("expected whitelist-only dnat after geo drop: %s", s)
	}
	if !strings.Contains(s, "ip saddr @geo_v4 tcp dport { 443 } limit rate 5/minute burst 20 packets log prefix \"evuproxy-geo-block: \" drop") {
		t.Fatalf("expected geo block on input for published port: %s", s)
	}
	if !strings.Contains(s, "ip saddr @route_src_0 tcp dport { 443 } accept") {
		t.Fatalf("expected source allow on input after geo drop: %s", s)
	}
}

func TestNFTablesPortMapping(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{{
		Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2",
		PortMaps: []config.PortMap{{Public: "25565", Internal: "19132"}},
	}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "tcp dport 25565 dnat to 10.100.0.2:19132") {
		t.Fatalf("expected mapped dnat: %s", s)
	}
}

func TestNFTablesMaintenanceMode(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.MaintenanceMode = true
	c.Forwarding.Routes = []config.ForwardRoute{{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "dnat to 10.100.0.2") {
		t.Fatal("maintenance should omit dnat rules")
	}
}

func TestNFTablesBreakGlassAndGlobalDeny(t *testing.T) {
	c := baseNFTConfig()
	c.Geo.Enabled = true
	c.Geo.Mode = "allow"
	c.Geo.SetName = "geo_v4"
	c.Geo.Countries = []string{"no"}
	c.Geo.ZoneDir = "/z"
	c.Geo.BreakGlassCIDRs = []string{"203.0.113.5"}
	c.Forwarding.SourceDenyCIDRs = []string{"198.51.100.0/24"}
	c.Forwarding.Routes = []config.ForwardRoute{{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "set break_glass_v4") || !strings.Contains(s, "set global_src_deny_v4") {
		t.Fatalf("expected policy sets: %s", s)
	}
	globalDrop := "ip saddr @global_src_deny_v4 tcp dport 25565 drop"
	breakDNAT := "ip saddr @break_glass_v4 tcp dport 25565 dnat"
	if !strings.Contains(s, globalDrop) {
		t.Fatal("expected global deny drop before DNAT")
	}
	if !strings.Contains(s, breakDNAT) {
		t.Fatal("expected break-glass dnat after geo allow")
	}
	if strings.Index(s, globalDrop) > strings.Index(s, breakDNAT) {
		t.Fatal("global deny must be evaluated before break-glass dnat")
	}
}

func TestNFTablesPerRouteDenyBeforeDnat(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{{
		Proto:           "tcp",
		Ports:           []string{"25565"},
		TargetIP:        "10.100.0.2",
		SourceDenyCIDRs: []string{"198.51.100.0/24"},
	}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	deny := "ip saddr @route_deny_0 tcp dport 25565 drop"
	dnat := "tcp dport 25565 dnat to 10.100.0.2"
	if !strings.Contains(s, deny) || !strings.Contains(s, dnat) {
		t.Fatalf("expected deny and dnat: %s", s)
	}
	if strings.Index(s, deny) > strings.Index(s, dnat) {
		t.Fatal("per-route deny must precede DNAT")
	}
}

func TestNFTablesGeoBlockBreakGlassExcludesGeoDrop(t *testing.T) {
	c := baseNFTConfig()
	c.Geo.Enabled = true
	c.Geo.Mode = "block"
	c.Geo.SetName = "geo_v4"
	c.Geo.Countries = []string{"no"}
	c.Geo.ZoneDir = "/z"
	c.Geo.BreakGlassCIDRs = []string{"203.0.113.5"}
	c.Forwarding.Routes = []config.ForwardRoute{{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	want := "ip saddr @geo_v4 ip saddr != @break_glass_v4 tcp dport 25565 drop"
	if !strings.Contains(s, want) {
		t.Fatalf("expected geo block with break-glass exclusion: %s", s)
	}
}

func TestNFTablesRouteGeoOffSkipsGeo(t *testing.T) {
	c := baseNFTConfig()
	c.Geo.Enabled = true
	c.Geo.Mode = "allow"
	c.Geo.SetName = "geo_v4"
	c.Geo.Countries = []string{"no"}
	c.Geo.ZoneDir = "/z"
	c.Forwarding.Routes = []config.ForwardRoute{{
		Proto:    "tcp",
		Ports:    []string{"25565"},
		TargetIP: "10.100.0.2",
		GeoMode:  config.RouteGeoOff,
	}}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "ip saddr @geo_v4 tcp dport 25565 dnat") {
		t.Fatal("geo_mode off should not reference geo set on route dnat")
	}
	if !strings.Contains(s, "tcp dport 25565 dnat to 10.100.0.2") {
		t.Fatal("expected open dnat when geo off")
	}
}

func baseNFTConfig() *config.Config {
	return &config.Config{
		WireGuard: config.WireGuard{
			Interface: "wg0", ListenPort: 51830, PrivateKeyFile: "/k", Address: "10.100.0.1/24",
		},
		Network:    config.Network{PublicInterface: "eth0"},
		Geo:        config.Geo{Enabled: false},
		Forwarding: config.Forwarding{},
		Peers:      []config.Peer{{Name: "a", PublicKey: "x", TunnelIP: "10.100.0.2/32"}},
	}
}

func TestNFTables_rateLimit_offByDefault(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "evuproxy-ratelimit:") {
		t.Fatal("rate limits off by default")
	}
}

func TestNFTables_rateLimit_tcpSynAndConn(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 40, MaxConnPerIP: 80}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "set ratelimit_conn_v4") || !strings.Contains(s, "set ratelimit_syn_v4") {
		t.Fatalf("missing rate limit dynamic sets: %s", s)
	}
	if !strings.Contains(s, "update @ratelimit_conn_v4 { ip saddr } ct count over 80") {
		t.Fatalf("missing max conn update rule: %s", s)
	}
	if !strings.Contains(s, "ip saddr @ratelimit_conn_v4") {
		t.Fatalf("missing max conn drop rule: %s", s)
	}
	if !strings.Contains(s, "tcp flags syn ct state new add @ratelimit_syn_v4 { ip saddr limit rate 40/second") {
		t.Fatalf("missing syn rate rule: %s", s)
	}
	if !strings.Contains(s, `iifname "eth0" oifname "wg0"`) || !strings.Contains(s, "evuproxy-ratelimit:") {
		t.Fatalf("missing forward-chain rate limit: %s", s)
	}
}

func TestNFTables_rateLimit_forwardBeforeAccept(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	fwdIdx := strings.Index(s, "chain forward")
	acceptIdx := strings.Index(s[fwdIdx:], "ip daddr 10.100.0.2 tcp dport")
	limIdx := strings.Index(s[fwdIdx:], "evuproxy-ratelimit:")
	if limIdx < 0 || acceptIdx < 0 || limIdx > acceptIdx {
		t.Fatalf("rate limit should appear in forward before accept; fwd=%q", s[fwdIdx:])
	}
}

func TestNFTables_rateLimit_maxConnBeforeEstablishedAccept(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{MaxConnPerIP: 5}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	fwdIdx := strings.Index(s, "chain forward")
	if fwdIdx < 0 {
		t.Fatal("missing forward chain")
	}
	chunk := s[fwdIdx:]
	connIdx := strings.Index(chunk, "update @ratelimit_conn_v4 { ip saddr } ct count over 5")
	estIdx := strings.Index(chunk, "ct state established,related accept")
	if connIdx < 0 || estIdx < 0 || connIdx > estIdx {
		t.Fatalf("max conn must precede blanket established accept in forward; chunk=%q", chunk)
	}
}

func TestNFTables_rateLimit_breakGlassExempt(t *testing.T) {
	c := baseNFTConfig()
	c.Geo.BreakGlassCIDRs = []string{"203.0.113.5/32"}
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "ip saddr != @break_glass_v4 tcp dport") || !strings.Contains(s, "evuproxy-ratelimit:") {
		t.Fatalf("expected break-glass exempt rate limit: %s", s)
	}
}

func TestNFTables_rateLimit_crowdsecBeforeRateLimit(t *testing.T) {
	c := baseNFTConfig()
	c.CrowdSec.Enabled = true
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	inIdx := strings.Index(s, "chain input")
	if inIdx < 0 {
		t.Fatal("no input chain")
	}
	chunk := s[inIdx:]
	cs := strings.Index(chunk, "crowdsec_block_v4")
	rl := strings.Index(chunk, "evuproxy-ratelimit:")
	if cs < 0 || rl < 0 || cs > rl {
		t.Fatalf("crowdsec drop should precede rate limit in input: %s", chunk)
	}
}

func TestNFTables_rateLimit_routeOverrideUDP(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10}
	c.Forwarding.Routes = []config.ForwardRoute{
		{
			Proto:     "udp",
			Ports:     []string{"19132"},
			TargetIP:  "10.100.0.2",
			RateLimit: config.RateLimit{UDPPerSecond: 200},
		},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(s, "tcp flags syn") {
		t.Fatal("udp route should not get tcp syn limit from global")
	}
	if !strings.Contains(s, "set ratelimit_udp_r0") {
		t.Fatalf("route override should use per-route udp set: %s", s)
	}
	if !strings.Contains(s, "udp dport") || !strings.Contains(s, "add @ratelimit_udp_r0 { ip saddr limit rate 200/second") {
		t.Fatalf("missing udp rate: %s", s)
	}
}

func TestNFTables_rateLimit_globalAndPerRouteSets(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2", RateLimit: config.RateLimit{TCPSynPerSecond: 100}},
		{Proto: "tcp", Ports: []string{"8080"}, TargetIP: "10.100.0.3"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, "set ratelimit_syn_v4") {
		t.Fatalf("missing global syn set: %s", s)
	}
	if !strings.Contains(s, "set ratelimit_syn_r0") {
		t.Fatalf("missing per-route syn set for route 0: %s", s)
	}
	if strings.Contains(s, "set ratelimit_syn_r1") {
		t.Fatal("route 1 should use global set, not per-route set")
	}
	if !strings.Contains(s, "add @ratelimit_syn_r0 { ip saddr limit rate 100/second") {
		t.Fatalf("route 0 should use 100/s on per-route set: %s", s)
	}
	if !strings.Contains(s, "add @ratelimit_syn_v4 { ip saddr limit rate 10/second") {
		t.Fatalf("route 1 should use global 10/s: %s", s)
	}
}

func TestNFTables_rateLimit_notInPrerouting(t *testing.T) {
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 10, MaxConnPerIP: 20}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	pre := strings.Index(s, "chain prerouting")
	post := strings.Index(s, "chain postrouting")
	if pre < 0 || post < 0 || pre >= post {
		t.Fatalf("expected prerouting/postrouting chains: %s", s)
	}
	if strings.Contains(s[pre:post], "evuproxy-ratelimit:") {
		t.Fatalf("rate limits must not appear in nat prerouting: %s", s[pre:post])
	}
}

func TestNFTables_rateLimit_nftCheck(t *testing.T) {
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("nft not in PATH")
	}
	c := baseNFTConfig()
	c.Forwarding.RateLimit = config.RateLimit{TCPSynPerSecond: 40, MaxConnPerIP: 80, UDPPerSecond: 100}
	c.Forwarding.Routes = []config.ForwardRoute{
		{Proto: "tcp,udp", Ports: []string{"25565"}, TargetIP: "10.100.0.2"},
	}
	s, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.CreateTemp("", "evuproxy-ratelimit-*.nft")
	if err != nil {
		t.Fatal(err)
	}
	path := f.Name()
	defer os.Remove(path)
	if _, err := f.WriteString(s); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("nft", "-c", "-f", path).CombinedOutput()
	if err != nil {
		syntax := []string{}
		for _, line := range strings.Split(string(out), "\n") {
			if strings.Contains(line, "syntax error") {
				syntax = append(syntax, line)
			}
		}
		if len(syntax) > 0 {
			t.Fatalf("nft -c syntax errors:\n%s", strings.Join(syntax, "\n"))
		}
		if !strings.Contains(string(out), "netlink") {
			t.Fatalf("nft -c failed: %v\n%s", err, out)
		}
	}
}
