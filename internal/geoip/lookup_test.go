package geoip

import (
	"encoding/binary"
	"net"
	"testing"

	"github.com/oschwald/geoip2-golang"
)

func TestCountryISOCodeLower_nilReader(t *testing.T) {
	if got := CountryISOCodeLower(nil, "192.0.2.1"); got != "" {
		t.Fatalf("got %q", got)
	}
}

func TestCountryISOCodeLower(t *testing.T) {
	r := openTestDB(t, "GeoLite2-Country", []mmdbEntry{
		{"192.0.2.0/24", isoRecord("SE")},
		{"198.51.100.0/25", isoRecord("  US ")},
		{"198.51.100.128/25", isoRecord("   ")},
		{"203.0.113.0/25", encodeMap("continent", encodeMap("code", encodeString("EU")))},
	})

	tests := []struct {
		name string
		ip   string
		want string
	}{
		{"known address is lowercased", "192.0.2.1", "se"},
		{"surrounding whitespace in the address is ignored", " 192.0.2.1\n", "se"},
		{"IPv4-mapped IPv6 finds the IPv4 record", "::ffff:192.0.2.1", "se"},
		{"whitespace in the stored code is trimmed", "198.51.100.1", "us"},
		{"blank stored code is unknown", "198.51.100.129", ""},
		{"record without a country is unknown", "203.0.113.1", ""},
		{"address outside the database is unknown", "203.0.113.200", ""},
		{"IPv6 lookup error in an IPv4 database is unknown", "2001:db8::1", ""},
		{"CIDR is not an address", "192.0.2.1/24", ""},
		{"garbage is not an address", "not-an-ip", ""},
		{"empty", "", ""},
		{"only whitespace", "   ", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := CountryISOCodeLower(r, tc.ip); got != tc.want {
				t.Fatalf("CountryISOCodeLower(%q) = %q, want %q", tc.ip, got, tc.want)
			}
		})
	}
}

func TestCountryISOCodeLower_databaseTypes(t *testing.T) {
	entries := []mmdbEntry{{"192.0.2.0/24", isoRecord("SE")}}

	// City databases carry country data too, and operators may configure one.
	if got := CountryISOCodeLower(openTestDB(t, "GeoLite2-City", entries), "192.0.2.1"); got != "se" {
		t.Fatalf("city database: got %q", got)
	}
	// The reader refuses a country lookup on this type; that must read as unknown.
	if got := CountryISOCodeLower(openTestDB(t, "GeoIP2-Anonymous-IP", entries), "192.0.2.1"); got != "" {
		t.Fatalf("anonymous-IP database: got %q", got)
	}
}

// mmdbEntry maps an IPv4 CIDR to an already encoded data section value.
type mmdbEntry struct {
	cidr   string
	record []byte
}

func isoRecord(code string) []byte {
	return encodeMap("country", encodeMap("iso_code", encodeString(code)))
}

func openTestDB(t *testing.T, dbType string, entries []mmdbEntry) *geoip2.Reader {
	t.Helper()
	r, err := geoip2.FromBytes(buildMMDB(t, dbType, entries))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.Close() })
	return r
}

// buildMMDB assembles a minimal IPv4 MaxMind DB (format 2.0, 24-bit records) so the
// tests run the real reader without a licensed database or a download.
func buildMMDB(t *testing.T, dbType string, entries []mmdbEntry) []byte {
	t.Helper()
	const (
		empty    = -1
		leafBase = 1 << 30 // marks a tree slot as pointing at the data section
	)
	nodes := [][2]int{{empty, empty}}
	var data []byte
	for _, e := range entries {
		_, ipnet, err := net.ParseCIDR(e.cidr)
		if err != nil {
			t.Fatal(err)
		}
		ip4 := ipnet.IP.To4()
		if ip4 == nil {
			t.Fatalf("%s is not IPv4", e.cidr)
		}
		prefix, _ := ipnet.Mask.Size()
		cur := 0
		for i := range prefix {
			bit := int(ip4[i/8]>>(7-i%8)) & 1
			if i == prefix-1 {
				nodes[cur][bit] = leafBase + len(data)
				break
			}
			if nodes[cur][bit] == empty {
				nodes = append(nodes, [2]int{empty, empty})
				nodes[cur][bit] = len(nodes) - 1
			}
			cur = nodes[cur][bit]
		}
		data = append(data, e.record...)
	}

	nodeCount := len(nodes)
	var out []byte
	for _, n := range nodes {
		for _, slot := range n {
			v := slot
			switch {
			case slot == empty:
				v = nodeCount
			case slot >= leafBase:
				v = nodeCount + 16 + (slot - leafBase)
			}
			out = append(out, byte(v>>16), byte(v>>8), byte(v))
		}
	}
	out = append(out, make([]byte, 16)...)
	out = append(out, data...)
	out = append(out, "\xab\xcd\xefMaxMind.com"...)
	out = append(out, encodeMap(
		"binary_format_major_version", encodeUint16(2),
		"binary_format_minor_version", encodeUint16(0),
		"build_epoch", encodeUint32(1700000000),
		"database_type", encodeString(dbType),
		"description", encodeMap("en", encodeString("evuproxy test database")),
		"ip_version", encodeUint16(4),
		"languages", encodeArray(encodeString("en")),
		"node_count", encodeUint32(uint32(nodeCount)),
		"record_size", encodeUint16(24),
	)...)
	return out
}

// Data section encoders; sizes stay under 29, so one control byte always holds them.

func encodeString(s string) []byte {
	return append([]byte{2<<5 | byte(len(s))}, s...)
}

func encodeUint16(v uint16) []byte {
	return binary.BigEndian.AppendUint16([]byte{5<<5 | 2}, v)
}

func encodeUint32(v uint32) []byte {
	return binary.BigEndian.AppendUint32([]byte{6<<5 | 4}, v)
}

func encodeArray(items ...[]byte) []byte {
	// Array is an extended type: type bits 0, then the type number minus 7.
	out := []byte{byte(len(items)), 11 - 7}
	for _, it := range items {
		out = append(out, it...)
	}
	return out
}

// encodeMap takes alternating string keys and encoded values.
func encodeMap(kv ...any) []byte {
	out := []byte{7<<5 | byte(len(kv)/2)}
	for i := 0; i < len(kv); i += 2 {
		out = append(out, encodeString(kv[i].(string))...)
		out = append(out, kv[i+1].([]byte)...)
	}
	return out
}
