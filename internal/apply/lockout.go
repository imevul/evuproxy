package apply

import (
	"fmt"
	"strings"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
	"github.com/imevul/evuproxy/internal/geoip"
)

// LockoutWarning is a best-effort lockout risk for the detected client IP.
type LockoutWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// LockoutWarnings evaluates config against clientIP (empty skips IP-specific checks).
func LockoutWarnings(c *config.Config, clientIP string, geoReader *geoip2.Reader) []LockoutWarning {
	if c == nil {
		return nil
	}
	var out []LockoutWarning
	if c.Forwarding.MaintenanceMode {
		out = append(out, LockoutWarning{
			Code:    "lockout_risk_maintenance",
			Message: "Maintenance mode is enabled; all public port forwards are omitted until disabled and reloaded.",
		})
	}
	ip := strings.TrimSpace(clientIP)
	if ip == "" {
		return out
	}
	if IPv4ContainedInCIDRs(ip, c.Forwarding.SourceDenyCIDRs) {
		out = append(out, LockoutWarning{
			Code:    "lockout_risk_source_deny",
			Message: fmt.Sprintf("Global forward denylist includes your address (%s).", ip),
		})
	}
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		if IPv4ContainedInCIDRs(ip, r.SourceDenyCIDRs) {
			out = append(out, LockoutWarning{
				Code:    "lockout_risk_source_deny",
				Message: fmt.Sprintf("Route %d denylist includes your address (%s).", i, ip),
			})
		}
		if len(r.SourceAllowCIDRs) > 0 && !IPv4ContainedInCIDRs(ip, r.SourceAllowCIDRs) {
			out = append(out, LockoutWarning{
				Code:    "lockout_risk_source_allow",
				Message: fmt.Sprintf("Route %d allowlist does not include your address (%s).", i, ip),
			})
		}
	}
	if w := geoLockoutWarning(c, ip, geoReader); w != nil {
		out = append(out, *w)
	}
	return out
}

func geoLockoutWarning(c *config.Config, ip string, geoReader *geoip2.Reader) *LockoutWarning {
	if IPv4ContainedInCIDRs(ip, c.Geo.BreakGlassCIDRs) {
		return nil
	}
	for i, r := range c.Forwarding.Routes {
		if r.Disabled {
			continue
		}
		countries, applies := routeGeoCountries(c, r)
		if !applies || len(countries) == 0 {
			continue
		}
		if geoWouldBlock(c, ip, countries, geoReader) {
			return &LockoutWarning{
				Code: "lockout_risk_geo",
				Message: fmt.Sprintf(
					"Geoblocking may block your address (%s) on route %d (%s mode).",
					ip, i, strings.ToLower(strings.TrimSpace(c.Geo.Mode)),
				),
			}
		}
	}
	return nil
}

func routeGeoCountries(c *config.Config, r config.ForwardRoute) (countries []string, applies bool) {
	mode := strings.ToLower(strings.TrimSpace(r.GeoMode))
	if mode == "" {
		mode = config.RouteGeoInherit
	}
	if mode == config.RouteGeoOff {
		return nil, false
	}
	if mode == config.RouteGeoCustom {
		return r.GeoCountries, c.Geo.Enabled
	}
	return c.Geo.Countries, c.Geo.Enabled
}

func geoWouldBlock(c *config.Config, ip string, countries []string, geoReader *geoip2.Reader) bool {
	block := strings.EqualFold(strings.TrimSpace(c.Geo.Mode), "block")
	inZone := ipInCountryZones(c, ip, countries) || ipCountryInList(ip, countries, geoReader)
	if block {
		return inZone
	}
	return !inZone
}

func ipCountryInList(ip string, countries []string, geoReader *geoip2.Reader) bool {
	if geoReader == nil {
		return false
	}
	cc := geoip.CountryISOCodeLower(geoReader, ip)
	if cc == "" {
		return false
	}
	for _, want := range countries {
		if strings.EqualFold(strings.TrimSpace(want), cc) {
			return true
		}
	}
	return false
}

func ipInCountryZones(c *config.Config, ip string, countries []string) bool {
	if !c.Geo.Enabled || strings.TrimSpace(c.Geo.ZoneDir) == "" {
		return false
	}
	elems, err := gen.ZoneCIDRsForCountries(c.Geo.ZoneDir, countries)
	if err != nil || len(elems) == 0 {
		return false
	}
	return IPv4ContainedInCIDRs(ip, elems)
}
