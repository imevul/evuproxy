package apply

import (
	"fmt"
	"net"
	"strings"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
	"github.com/imevul/evuproxy/internal/geoip"
)

// IPCheckResult is a dry-run answer to "what would this source IPv4 hit under geo / denylist rules?"
//
// It does not probe the live nftables set — it evaluates zone files per listed country
// (plus optional GeoLite2). CrowdSec and rate limits are out of scope.
type IPCheckResult struct {
	IP               string   `json:"ip"`
	OK               bool     `json:"ok"`
	Verdict          string   `json:"verdict"` // allowed | blocked | geo_off | uncertain | invalid
	Summary          string   `json:"summary"`
	GeoEnabled       bool     `json:"geo_enabled"`
	GeoMode          string   `json:"geo_mode,omitempty"`
	BreakGlass       bool     `json:"break_glass"`
	GlobalDeny       bool     `json:"global_deny"`
	InListedZones    bool     `json:"in_listed_zones"`
	MatchedCountries []string `json:"matched_countries,omitempty"`
	CountryISO       string   `json:"country_iso,omitempty"`
	ApplyToInbound   bool     `json:"apply_to_input_allows"`
	CheckedFromDraft bool     `json:"checked_from_draft,omitempty"`
	Note             string   `json:"note,omitempty"`
}

type countryMatchScan struct {
	matched       []string
	listed        int
	zonesReadable int
	zonesMissing  int
	note          string
}

// CheckSourceIP evaluates how a WAN IPv4 would fare against geo and the global forward denylist.
func CheckSourceIP(c *config.Config, ipStr string, geoReader *geoip2.Reader, fromDraft bool) *IPCheckResult {
	res := &IPCheckResult{CheckedFromDraft: fromDraft}
	ip := strings.TrimSpace(ipStr)
	res.IP = ip
	if c == nil {
		res.OK = false
		res.Verdict = "invalid"
		res.Summary = "No configuration available to check against."
		return res
	}
	parsed := net.ParseIP(ip)
	if parsed == nil || parsed.To4() == nil {
		res.OK = false
		res.Verdict = "invalid"
		res.Summary = "Enter a valid IPv4 address."
		return res
	}
	ip = parsed.To4().String()
	res.IP = ip
	res.OK = true

	res.GeoEnabled = c.Geo.Enabled
	res.GeoMode = strings.ToLower(strings.TrimSpace(c.Geo.Mode))
	if res.GeoMode == "" {
		res.GeoMode = "allow"
	}
	res.ApplyToInbound = c.Geo.ApplyToInputAllows
	res.BreakGlass = IPv4ContainedInCIDRs(ip, c.Geo.BreakGlassCIDRs)
	res.GlobalDeny = IPv4ContainedInCIDRs(ip, c.Forwarding.SourceDenyCIDRs)
	if geoReader != nil {
		res.CountryISO = geoip.CountryISOCodeLower(geoReader, ip)
	}

	if !c.Geo.Enabled {
		res.Verdict = "geo_off"
		if res.GlobalDeny {
			res.Verdict = "blocked"
			res.Summary = fmt.Sprintf(
				"%s is on the global forward denylist. Geoblocking is off, so country rules do not apply.",
				ip,
			)
			return res
		}
		res.Summary = fmt.Sprintf("%s is not filtered by country rules (geoblocking is off).", ip)
		return res
	}

	scan := scanCountriesContainingIP(c, ip, c.Geo.Countries, geoReader)
	res.MatchedCountries = scan.matched
	res.InListedZones = len(scan.matched) > 0
	if scan.note != "" {
		res.Note = scan.note
	}

	// Global denylist sits ahead of geo on the forward path.
	if res.GlobalDeny {
		res.Verdict = "blocked"
		res.Summary = fmt.Sprintf("%s is on the global forward denylist (checked before geoblocking).", ip)
		return res
	}
	if res.BreakGlass {
		res.Verdict = "allowed"
		res.Summary = fmt.Sprintf("%s matches a break-glass CIDR and bypasses geoblocking.", ip)
		return res
	}

	// One verdict source: the per-country scan. Batching all countries into a single
	// ZoneCIDRsForCountries call (as lockout does) fails the whole lookup when any
	// one zone is missing, which disagreed with MatchedCountries.
	if !membershipKnown(scan, res.CountryISO) {
		res.Verdict = "uncertain"
		res.Summary = fmt.Sprintf(
			"Not enough country data to decide for %s. Update geo lists or configure GeoLite2, then check again.",
			ip,
		)
		res.Note = appendNote(res.Note, "No confident zone or GeoLite2 match for the listed countries.")
		return res
	}

	inList := res.InListedZones
	blocked := (res.GeoMode == "block") == inList
	if blocked {
		res.Verdict = "blocked"
		if res.GeoMode == "block" {
			res.Summary = fmt.Sprintf(
				"%s matches a listed country and would be blocked (block mode).",
				ip,
			)
		} else {
			res.Summary = fmt.Sprintf(
				"%s is not in any listed country and would be blocked (allow mode).",
				ip,
			)
		}
	} else {
		res.Verdict = "allowed"
		if res.GeoMode == "block" {
			res.Summary = fmt.Sprintf(
				"%s is not in a listed country and would be allowed (block mode).",
				ip,
			)
		} else {
			res.Summary = fmt.Sprintf(
				"%s matches a listed country and would be allowed (allow mode).",
				ip,
			)
		}
	}
	if res.ApplyToInbound {
		res.Note = appendNote(res.Note, "Geoblocking also applies to inbound allow rules (input_allows).")
	}
	return res
}

// membershipKnown reports whether InListedZones is trustworthy enough for a verdict.
// A positive match is always enough. A negative needs either a GeoLite2 country code
// or a complete set of readable zone files (or an empty country list).
func membershipKnown(scan countryMatchScan, countryISO string) bool {
	if len(scan.matched) > 0 {
		return true
	}
	if scan.listed == 0 {
		return true
	}
	if countryISO != "" {
		return true
	}
	if scan.zonesMissing == 0 && scan.zonesReadable == scan.listed {
		return true
	}
	return false
}

func scanCountriesContainingIP(c *config.Config, ip string, countries []string, geoReader *geoip2.Reader) countryMatchScan {
	var scan countryMatchScan
	zoneDir := strings.TrimSpace(c.Geo.ZoneDir)
	for _, raw := range countries {
		cc := strings.ToLower(strings.TrimSpace(raw))
		if cc == "" {
			continue
		}
		scan.listed++
		inZone := false
		if zoneDir != "" {
			elems, err := gen.ZoneCIDRsForCountries(zoneDir, []string{cc})
			if err != nil || len(elems) == 0 {
				scan.zonesMissing++
			} else {
				scan.zonesReadable++
				if IPv4ContainedInCIDRs(ip, elems) {
					inZone = true
				}
			}
		} else {
			scan.zonesMissing++
		}
		if !inZone && geoReader != nil {
			if geoip.CountryISOCodeLower(geoReader, ip) == cc {
				inZone = true
			}
		}
		if inZone {
			scan.matched = append(scan.matched, cc)
		}
	}
	if zoneDir == "" {
		scan.note = "No zone directory configured; country match uses GeoLite2 when available."
	} else if scan.zonesMissing > 0 && len(scan.matched) == 0 {
		scan.note = "Some zone files could not be read; match may be incomplete until Update geo lists succeeds."
	}
	return scan
}

func appendNote(existing, add string) string {
	if existing == "" {
		return add
	}
	return existing + " " + add
}
