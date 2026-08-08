package apply

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func writeZone(t *testing.T, dir, cc, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, cc+".zone"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCheckSourceIP_invalid(t *testing.T) {
	res := CheckSourceIP(&config.Config{}, "not-an-ip", nil, false)
	if res.OK || res.Verdict != "invalid" {
		t.Fatalf("got %+v", res)
	}
}

func TestCheckSourceIP_geoOff(t *testing.T) {
	c := &config.Config{Geo: config.Geo{Enabled: false}}
	res := CheckSourceIP(c, "203.0.113.5", nil, false)
	if !res.OK || res.Verdict != "geo_off" {
		t.Fatalf("got %+v", res)
	}
}

func TestCheckSourceIP_allowMode(t *testing.T) {
	dir := t.TempDir()
	writeZone(t, dir, "se", "203.0.113.0/24\n")
	c := &config.Config{
		Geo: config.Geo{
			Enabled:   true,
			Mode:      "allow",
			Countries: []string{"se"},
			ZoneDir:   dir,
		},
	}
	in := CheckSourceIP(c, "203.0.113.9", nil, false)
	if !in.OK || in.Verdict != "allowed" || !in.InListedZones {
		t.Fatalf("in-list: %+v", in)
	}
	out := CheckSourceIP(c, "198.51.100.1", nil, false)
	if !out.OK || out.Verdict != "blocked" || out.InListedZones {
		t.Fatalf("out-of-list: %+v", out)
	}
}

func TestCheckSourceIP_blockModeAndBreakGlass(t *testing.T) {
	dir := t.TempDir()
	writeZone(t, dir, "se", "203.0.113.0/24\n")
	c := &config.Config{
		Geo: config.Geo{
			Enabled:         true,
			Mode:            "block",
			Countries:       []string{"se"},
			ZoneDir:         dir,
			BreakGlassCIDRs: []string{"203.0.113.50/32"},
		},
	}
	blocked := CheckSourceIP(c, "203.0.113.9", nil, false)
	if blocked.Verdict != "blocked" {
		t.Fatalf("expected blocked, got %+v", blocked)
	}
	glass := CheckSourceIP(c, "203.0.113.50", nil, false)
	if glass.Verdict != "allowed" || !glass.BreakGlass {
		t.Fatalf("expected break-glass allow, got %+v", glass)
	}
}

func TestCheckSourceIP_globalDenyWins(t *testing.T) {
	dir := t.TempDir()
	writeZone(t, dir, "se", "203.0.113.0/24\n")
	c := &config.Config{
		Geo: config.Geo{
			Enabled:   true,
			Mode:      "allow",
			Countries: []string{"se"},
			ZoneDir:   dir,
		},
		Forwarding: config.Forwarding{
			SourceDenyCIDRs: []string{"203.0.113.0/24"},
		},
	}
	res := CheckSourceIP(c, "203.0.113.9", nil, false)
	if res.Verdict != "blocked" || !res.GlobalDeny {
		t.Fatalf("got %+v", res)
	}
}

// A missing sibling zone must not wipe a match from a readable one, and must not
// invent a confident "not in list" when membership cannot be proven.
func TestCheckSourceIP_partialZones(t *testing.T) {
	dir := t.TempDir()
	writeZone(t, dir, "se", "203.0.113.0/24\n")
	// "us" is listed but has no zone file on disk.
	c := &config.Config{
		Geo: config.Geo{
			Enabled:   true,
			Mode:      "allow",
			Countries: []string{"se", "us"},
			ZoneDir:   dir,
		},
	}
	in := CheckSourceIP(c, "203.0.113.9", nil, false)
	if in.Verdict != "allowed" || !in.InListedZones {
		t.Fatalf("readable zone match: %+v", in)
	}
	unknown := CheckSourceIP(c, "198.51.100.1", nil, false)
	if unknown.Verdict != "uncertain" {
		t.Fatalf("expected uncertain without full zone coverage, got %+v", unknown)
	}
}

func TestCheckSourceIP_noZoneDataUncertain(t *testing.T) {
	c := &config.Config{
		Geo: config.Geo{
			Enabled:   true,
			Mode:      "block",
			Countries: []string{"se"},
			ZoneDir:   "",
		},
	}
	res := CheckSourceIP(c, "203.0.113.9", nil, false)
	if res.Verdict != "uncertain" {
		t.Fatalf("block mode must not fail-open to allowed without data: %+v", res)
	}
}
