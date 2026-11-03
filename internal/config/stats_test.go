package config

import (
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestStatsDropCounters_yaml(t *testing.T) {
	var c Config
	if err := yaml.Unmarshal([]byte("stats:\n  drop_counters: true\n"), &c); err != nil {
		t.Fatal(err)
	}
	if !c.Stats.DropCounters {
		t.Fatal("stats.drop_counters not parsed")
	}
}

// Saving a config that never set it must not add a stats block to the file.
func TestStatsDropCounters_offIsOmittedFromYAML(t *testing.T) {
	b, err := yaml.Marshal(Config{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "stats") {
		t.Fatalf("unexpected stats block:\n%s", b)
	}
}
