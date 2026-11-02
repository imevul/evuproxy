package gen

import (
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestGeoSetsEqual(t *testing.T) {
	base := func() *config.Config {
		return &config.Config{
			Geo: config.Geo{Enabled: true, Countries: []string{"se", "no"}, ZoneDir: "/zones"},
			Forwarding: config.Forwarding{Routes: []config.ForwardRoute{
				{GeoMode: config.RouteGeoCustom, GeoCountries: []string{"de"}},
			}},
		}
	}
	tests := []struct {
		name   string
		change func(c *config.Config)
		want   bool
	}{
		{"same", func(c *config.Config) {}, true},
		{"country order and case", func(c *config.Config) { c.Geo.Countries = []string{"NO", " se"} }, true},
		{"mode doesn't change a set", func(c *config.Config) { c.Geo.Mode = "block" }, true},
		{"country added", func(c *config.Config) { c.Geo.Countries = []string{"se", "no", "dk"} }, false},
		{"set renamed", func(c *config.Config) { c.Geo.SetName = "other" }, false},
		{"zone dir", func(c *config.Config) { c.Geo.ZoneDir = "/other" }, false},
		{"geo turned off", func(c *config.Config) { c.Geo.Enabled = false }, false},
		{"route country", func(c *config.Config) { c.Forwarding.Routes[0].GeoCountries = []string{"fr"} }, false},
		{"route disabled", func(c *config.Config) { c.Forwarding.Routes[0].Disabled = true }, false},
		{"route moved: its set is named by position", func(c *config.Config) {
			c.Forwarding.Routes = append([]config.ForwardRoute{{}}, c.Forwarding.Routes...)
		}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := base()
			tt.change(c)
			if got := GeoSetsEqual(base(), c); got != tt.want {
				t.Fatalf("got %v, want %v", got, tt.want)
			}
		})
	}
}
