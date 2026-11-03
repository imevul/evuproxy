package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"
)

const autoPauseBaseYAML = `
wireguard:
  interface: wg0
  listen_port: 51820
  private_key_file: /key
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes:
    - proto: tcp
      ports: ["25565"]
      target_ip: 10.100.0.2
geo:
  enabled: false
input_allows: []
peers:
  - name: a
    public_key: ` + testWGKeyA + `
    tunnel_ip: 10.100.0.2/32
`

func writeAutoPauseConfig(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "config.yaml")
	if err := os.WriteFile(p, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestAutoPause_existingConfigLoadsWithDefaults(t *testing.T) {
	c, err := Load(writeAutoPauseConfig(t, autoPauseBaseYAML))
	if err != nil {
		t.Fatal(err)
	}
	if c.Forwarding.Routes[0].PauseWhenPeerOffline {
		t.Fatal("pause_when_peer_offline should default to off")
	}
	a := c.AutoPause
	if a.EffectiveFailuresToPause() != 3 || a.EffectiveSuccessesToResume() != 2 ||
		a.EffectiveInterval() != 15*time.Second || a.ICMPFallback {
		t.Fatalf("defaults: %+v", a)
	}
}

func TestAutoPause_existingConfigRoundTripAddsNothing(t *testing.T) {
	c, err := Load(writeAutoPauseConfig(t, autoPauseBaseYAML))
	if err != nil {
		t.Fatal(err)
	}
	y, err := yaml.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	j, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	for _, out := range []string{string(y), string(j)} {
		if strings.Contains(out, "auto_pause") || strings.Contains(out, "pause_when_peer_offline") {
			t.Fatalf("unset settings written out:\n%s", out)
		}
	}
}

func TestAutoPause_settingsSurviveRoundTrip(t *testing.T) {
	body := strings.Replace(autoPauseBaseYAML, "      target_ip: 10.100.0.2\n",
		"      target_ip: 10.100.0.2\n      pause_when_peer_offline: true\n", 1) + `
auto_pause:
  failures_to_pause: 5
  successes_to_resume: 4
  interval: 30s
  icmp_fallback: true
`
	c, err := Load(writeAutoPauseConfig(t, body))
	if err != nil {
		t.Fatal(err)
	}
	want := AutoPause{FailuresToPause: 5, SuccessesToResume: 4, Interval: "30s", ICMPFallback: true}
	check := func(got *Config) {
		t.Helper()
		if got.AutoPause != want {
			t.Fatalf("auto_pause = %+v", got.AutoPause)
		}
		if !got.Forwarding.Routes[0].PauseWhenPeerOffline {
			t.Fatal("pause_when_peer_offline lost")
		}
	}
	check(c)
	if c.AutoPause.EffectiveInterval() != 30*time.Second {
		t.Fatalf("interval = %v", c.AutoPause.EffectiveInterval())
	}

	y, err := yaml.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var fromYAML Config
	if err := yaml.Unmarshal(y, &fromYAML); err != nil {
		t.Fatal(err)
	}
	check(&fromYAML)

	// The admin UI edits config as JSON (GET then PUT).
	j, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var fromJSON Config
	if err := json.Unmarshal(j, &fromJSON); err != nil {
		t.Fatal(err)
	}
	check(&fromJSON)
}

func TestValidateAutoPause(t *testing.T) {
	cases := []struct {
		name string
		in   AutoPause
		ok   bool
	}{
		{"zero uses defaults", AutoPause{}, true},
		{"explicit", AutoPause{FailuresToPause: 1, SuccessesToResume: 100, Interval: "5s"}, true},
		{"max interval", AutoPause{Interval: "1h"}, true},
		{"negative failures", AutoPause{FailuresToPause: -1}, false},
		{"failures too large", AutoPause{FailuresToPause: 101}, false},
		{"negative successes", AutoPause{SuccessesToResume: -1}, false},
		{"successes too large", AutoPause{SuccessesToResume: 101}, false},
		{"unparsable interval", AutoPause{Interval: "soon"}, false},
		{"unitless interval", AutoPause{Interval: "15"}, false},
		{"interval too short", AutoPause{Interval: "4s"}, false},
		{"zero interval", AutoPause{Interval: "0s"}, false},
		{"interval too long", AutoPause{Interval: "2h"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateAutoPause(tc.in)
			if (err == nil) != tc.ok {
				t.Fatalf("err = %v, want ok = %v", err, tc.ok)
			}
		})
	}
}

func TestLoad_rejectsInvalidAutoPause(t *testing.T) {
	_, err := Load(writeAutoPauseConfig(t, autoPauseBaseYAML+"\nauto_pause:\n  interval: 1s\n"))
	if err == nil || !strings.Contains(err.Error(), "auto_pause.interval") {
		t.Fatalf("err = %v", err)
	}
}
