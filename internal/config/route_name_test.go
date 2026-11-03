package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Routes as a config written before forwarding.routes[].name existed.
const routesWithoutName = `forwarding:
    routes:
        - proto: tcp
          ports:
            - "25565"
          target_ip: 10.100.0.2
        - proto: udp
          ports:
            - "19132"
          target_ip: 10.100.0.2
          disabled: true
`

func TestRouteWithoutName_yamlSavesUnchanged(t *testing.T) {
	var in struct {
		Forwarding Forwarding `yaml:"forwarding"`
	}
	if err := yaml.Unmarshal([]byte(routesWithoutName), &in); err != nil {
		t.Fatal(err)
	}
	if got := in.Forwarding.Routes[0].Name; got != "" {
		t.Fatalf("name = %q, want empty", got)
	}
	var buf strings.Builder
	enc := yaml.NewEncoder(&buf)
	if err := enc.Encode(in); err != nil {
		t.Fatal(err)
	}
	if err := enc.Close(); err != nil {
		t.Fatal(err)
	}
	if got := buf.String(); got != routesWithoutName {
		t.Fatalf("saved YAML changed.\ngot:\n%s\nwant:\n%s", got, routesWithoutName)
	}
}

func TestRouteWithoutName_jsonOmitsName(t *testing.T) {
	out, err := json.Marshal(ForwardRoute{Proto: "tcp", Ports: []string{"80"}, TargetIP: "10.100.0.2"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(out), `"name"`) {
		t.Fatalf("JSON has a name key: %s", out)
	}
}

func TestLoadConfigWithoutRouteNameValidates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeRouteNameConfig(t, path, "")
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Forwarding.Routes[0].Name; got != "" {
		t.Fatalf("name = %q, want empty", got)
	}
}

func TestRouteNameRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.yaml")
	writeRouteNameConfig(t, path, "name: Minecraft server")
	c, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := c.Forwarding.Routes[0].Name; got != "Minecraft server" {
		t.Fatalf("name = %q", got)
	}
	out, err := yaml.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var again Config
	if err := yaml.Unmarshal(out, &again); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(again.Forwarding.Routes, c.Forwarding.Routes) {
		t.Fatalf("routes changed: %+v vs %+v", again.Forwarding.Routes, c.Forwarding.Routes)
	}
}

func TestValidateRouteName(t *testing.T) {
	for _, tc := range []struct {
		label, name string
		wantErr     string
	}{
		{"empty", "", ""},
		{"plain", "Minecraft", ""},
		{"punctuation and unicode", `Söderberg's "game" <server> 🎮`, ""},
		{"64 multibyte characters", strings.Repeat("ö", 64), ""},
		{"surrounding space not counted", "  " + strings.Repeat("a", 64) + "  ", ""},
		{"65 characters", strings.Repeat("a", 65), "longer than 64"},
		{"newline", "a\nb", "control characters"},
		{"carriage return", "a\rb", "control characters"},
		{"NUL", "a\x00b", "control characters"},
	} {
		t.Run(tc.label, func(t *testing.T) {
			// Disabled routes skip every other check, so this also shows name is not skipped.
			for _, disabled := range []bool{false, true} {
				c := sampleBase()
				c.Peers = []Peer{{Name: "a", PublicKey: testWGKeyA, TunnelIP: "10.100.0.2/32"}}
				c.Forwarding = Forwarding{Routes: []ForwardRoute{
					{Name: tc.name, Proto: "tcp", Ports: []string{"25565"}, TargetIP: "10.100.0.2", Disabled: disabled},
				}}
				err := c.Validate()
				if tc.wantErr == "" {
					if err != nil {
						t.Fatalf("disabled=%v: %v", disabled, err)
					}
					continue
				}
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("disabled=%v: err = %v, want %q", disabled, err, tc.wantErr)
				}
				if !strings.Contains(err.Error(), "forwarding.routes[0]") {
					t.Fatalf("err = %v, want the route's position", err)
				}
			}
		})
	}
}

func writeRouteNameConfig(t *testing.T, path, nameLine string) {
	t.Helper()
	dir := filepath.Dir(path)
	keyPath := filepath.Join(dir, "wg.key")
	if err := os.WriteFile(keyPath, []byte("key\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	route := "    - proto: tcp\n"
	if nameLine != "" {
		route = "    - " + nameLine + "\n      proto: tcp\n"
	}
	body := `wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: ` + keyPath + `
  address: 10.100.0.1/24
network:
  public_interface: eth0
geo:
  enabled: false
forwarding:
  routes:
` + route + `      ports: ["25565"]
      target_ip: 10.100.0.2
peers:
  - name: a
    public_key: ` + testWGKeyA + `
    tunnel_ip: 10.100.0.2/32
`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}
