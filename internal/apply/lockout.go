package apply

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
	"github.com/imevul/evuproxy/internal/geoip"
	"github.com/imevul/evuproxy/internal/state"
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
			Message: "Maintenance mode is enabled; all public port forwards are omitted until disabled and applied.",
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

const (
	lockoutSSHPort = 22
	// lockoutUIPort is the default admin UI port. The API cannot see EVUPROXY_UI_LISTEN
	// (it is set on the UI container), so a custom port is only known through connPort.
	lockoutUIPort = 9080
)

// LoadAppliedConfig returns the last applied snapshot (config.yaml.bak), or nil when
// there is none or it no longer loads.
func LoadAppliedConfig(cfgPath string) *config.Config {
	c, err := config.Load(state.ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		return nil
	}
	return c
}

// InputAllowLockoutWarnings reports SSH, admin UI and current-connection ports (connPort,
// 0 when unknown) that applied accepts on INPUT and c no longer does. The chain policy is
// drop, so new connections to such a port are refused once c is applied.
//
// It compares against applied rather than looking at c alone: a removed rule leaves nothing
// to inspect, and a host that deliberately has no 9080 rule must not warn on every apply.
// A nil applied (nothing applied yet, or an unreadable snapshot) assumes every port is in
// use, because the running firewall is unknown.
func InputAllowLockoutWarnings(c, applied *config.Config, connPort int) []LockoutWarning {
	if c == nil {
		return nil
	}
	targets := []struct {
		port  int
		label string
	}{
		{lockoutSSHPort, "SSH"},
		{lockoutUIPort, "admin UI"},
	}
	if connPort > 0 {
		merged := false
		for i := range targets {
			if targets[i].port == connPort {
				targets[i].label += ", your current connection"
				merged = true
			}
		}
		if !merged {
			targets = append(targets, struct {
				port  int
				label string
			}{connPort, "your current connection"})
		}
	}
	var out []LockoutWarning
	for _, t := range targets {
		if tcpPortAccepted(c, t.port) || (applied != nil && !tcpPortAccepted(applied, t.port)) {
			continue
		}
		out = append(out, LockoutWarning{
			Code: "lockout_risk_input_allows",
			Message: fmt.Sprintf(
				"No enabled inbound rule allows TCP port %d (%s) in this config; new connections to it would be dropped.",
				t.port, t.label,
			),
		})
	}
	return out
}

// tcpPortAccepted reports whether c emits an INPUT accept for the TCP port, from an
// enabled input_allows rule or network.admin_tcp_ports.
func tcpPortAccepted(c *config.Config, port int) bool {
	for _, a := range c.InputAllows {
		if !a.Disabled && strings.EqualFold(strings.TrimSpace(a.Proto), "tcp") && dportCovers(a.DPort, port) {
			return true
		}
	}
	return slices.Contains(c.Network.AdminTCPPorts, port)
}

// dportCovers matches port against an input_allows dport: a port, a range or a {...} list.
func dportCovers(dport string, port int) bool {
	list := strings.Trim(strings.TrimSpace(dport), "{}")
	for _, tok := range strings.Split(list, ",") {
		loStr, hiStr, isRange := strings.Cut(strings.TrimSpace(tok), "-")
		if !isRange {
			hiStr = loStr
		}
		lo, errLo := strconv.Atoi(strings.TrimSpace(loStr))
		hi, errHi := strconv.Atoi(strings.TrimSpace(hiStr))
		if errLo == nil && errHi == nil && lo <= port && port <= hi {
			return true
		}
	}
	return false
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
