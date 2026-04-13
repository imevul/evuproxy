package config

import (
	"encoding/json"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestYAMLGeoApplyToInputAllowsRoundTrip(t *testing.T) {
	c := &Config{
		WireGuard: WireGuard{
			Interface: "i", ListenPort: 1, PrivateKeyFile: "k", Address: "10.0.0.1/24",
		},
		Network: Network{PublicInterface: "e"},
		Geo: Geo{
			Enabled: true, Mode: "allow", SetName: "geo_v4",
			Countries: []string{"no"}, ZoneDir: "/z",
			ApplyToInputAllows: true,
		},
	}
	b, err := yaml.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), "apply_to_input_allows: true") {
		t.Fatalf("expected apply_to_input_allows in yaml: %s", b)
	}
	var c2 Config
	if err := yaml.Unmarshal(b, &c2); err != nil {
		t.Fatal(err)
	}
	if !c2.Geo.ApplyToInputAllows {
		t.Fatal("unmarshal lost ApplyToInputAllows")
	}
}

func TestJSONGeoApplyToInputAllowsEncode(t *testing.T) {
	c := Config{
		WireGuard: WireGuard{
			Interface: "i", ListenPort: 1, PrivateKeyFile: "k", Address: "10.0.0.1/24",
		},
		Network: Network{PublicInterface: "e"},
		Geo: Geo{
			Enabled: true, Mode: "allow", SetName: "geo_v4",
			Countries: []string{"no"}, ZoneDir: "/z",
			ApplyToInputAllows: true,
		},
	}
	b, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"apply_to_input_allows":true`) {
		t.Fatalf("expected key in json: %s", b)
	}
	var c2 Config
	if err := json.Unmarshal(b, &c2); err != nil {
		t.Fatal(err)
	}
	if !c2.Geo.ApplyToInputAllows {
		t.Fatal("decode lost flag")
	}
}
