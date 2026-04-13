package geoip

import (
	"net"
	"strings"

	"github.com/oschwald/geoip2-golang"
)

// CountryISOCodeLower returns a lowercase ISO 3166-1 alpha-2 code for ipStr, or "" when unknown.
func CountryISOCodeLower(r *geoip2.Reader, ipStr string) string {
	if r == nil {
		return ""
	}
	ip := net.ParseIP(strings.TrimSpace(ipStr))
	if ip == nil {
		return ""
	}
	rec, err := r.Country(ip)
	if err != nil {
		return ""
	}
	cc := strings.TrimSpace(rec.Country.IsoCode)
	if cc == "" {
		return ""
	}
	return strings.ToLower(cc)
}
