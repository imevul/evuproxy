package apply

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/imevul/evuproxy/internal/config"
)

// GeoCountrySummary is one row for GET /api/v1/geo/summary.
type GeoCountrySummary struct {
	Code                string `json:"code"`
	CidrLines           int    `json:"cidr_lines"`
	ApproxIPv4Addresses uint64 `json:"approx_ipv4_addresses"`
	ZoneMissing         bool   `json:"zone_missing,omitempty"`
	ZoneReadError       string `json:"zone_read_error,omitempty"`
}

// GeoSummaryResponse is the JSON body for GET /api/v1/geo/summary.
type GeoSummaryResponse struct {
	Enabled           bool                `json:"enabled"`
	Mode              string              `json:"mode,omitempty"`
	Countries         []GeoCountrySummary `json:"countries"`
	NftSetElemCount   *int                `json:"nft_set_elem_count,omitempty"`
	NftSetCountSource string              `json:"nft_set_count_source,omitempty"`
}

var (
	geoSummaryMu      sync.RWMutex
	geoSummaryCache   *GeoSummaryResponse
	geoSummaryCfgPath string
	geoSummaryAt      time.Time
)

const geoSummaryTTL = 30 * time.Second

// InvalidateGeoSummaryCache clears cached geo summary (call after reload / update-geo success).
func InvalidateGeoSummaryCache() {
	geoSummaryMu.Lock()
	geoSummaryCache = nil
	geoSummaryCfgPath = ""
	geoSummaryAt = time.Time{}
	geoSummaryMu.Unlock()
}

// GeoSummary builds zone-file statistics for the UI (with short-lived cache).
func GeoSummary(cfgPath string) (*GeoSummaryResponse, error) {
	geoSummaryMu.RLock()
	if geoSummaryCache != nil && geoSummaryCfgPath == cfgPath && time.Since(geoSummaryAt) < geoSummaryTTL {
		c := *geoSummaryCache
		geoSummaryMu.RUnlock()
		return &c, nil
	}
	geoSummaryMu.RUnlock()

	built, err := buildGeoSummary(cfgPath)
	if err != nil {
		return nil, err
	}

	geoSummaryMu.Lock()
	defer geoSummaryMu.Unlock()
	if geoSummaryCache != nil && geoSummaryCfgPath == cfgPath && time.Since(geoSummaryAt) < geoSummaryTTL {
		c := *geoSummaryCache
		return &c, nil
	}
	geoSummaryCache = built
	geoSummaryCfgPath = cfgPath
	geoSummaryAt = time.Now()
	cp := *built
	return &cp, nil
}

func buildGeoSummary(cfgPath string) (*GeoSummaryResponse, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	out := &GeoSummaryResponse{Enabled: c.Geo.Enabled}
	if !c.Geo.Enabled {
		return out, nil
	}
	out.Mode = c.Geo.Mode
	set := strings.TrimSpace(c.Geo.SetName)
	if set == "" {
		set = "geo_v4"
	}
	for _, cc := range c.Geo.Countries {
		cc = strings.ToLower(strings.TrimSpace(cc))
		row := GeoCountrySummary{Code: cc}
		zpath := filepath.Join(c.Geo.ZoneDir, cc+".zone")
		b, err := os.ReadFile(zpath)
		if err != nil {
			row.ZoneMissing = true
			row.ZoneReadError = "missing or unreadable"
			out.Countries = append(out.Countries, row)
			continue
		}
		lines, hosts := summarizeZoneFile(b)
		row.CidrLines = lines
		row.ApproxIPv4Addresses = hosts
		out.Countries = append(out.Countries, row)
	}
	if n, src, ok := nftSetElemCount(context.Background(), set); ok {
		out.NftSetElemCount = &n
		out.NftSetCountSource = src
	}
	return out, nil
}

func summarizeZoneFile(b []byte) (cidrLines int, approxHosts uint64) {
	sc := bufio.NewScanner(bytes.NewReader(b))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		cidrLines++
		if n, ok := ipv4HostCount(line); ok {
			approxHosts += n
		}
	}
	return cidrLines, approxHosts
}

func ipv4HostCount(s string) (uint64, bool) {
	_, ipnet, err := net.ParseCIDR(strings.TrimSpace(s))
	if err != nil {
		ip := net.ParseIP(strings.TrimSpace(s))
		if ip == nil {
			return 0, false
		}
		ip4 := ip.To4()
		if ip4 == nil {
			return 0, false
		}
		return 1, true
	}
	ip4 := ipnet.IP.To4()
	if ip4 == nil {
		return 0, false
	}
	ones, bits := ipnet.Mask.Size()
	if bits != 32 {
		return 0, false
	}
	hostBits := 32 - ones
	if hostBits >= 32 {
		return 1 << 32, true
	}
	return uint64(1) << hostBits, true
}

func nftSetElemCount(ctx context.Context, setName string) (count int, source string, ok bool) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", "-j", "list", "set", "inet", "evuproxy", setName)
	out, err := cmd.Output()
	if err != nil || len(out) > 8<<20 {
		return 0, "", false
	}
	var root interface{}
	if json.Unmarshal(out, &root) != nil {
		return 0, "", false
	}
	n := walkNFTJSONCountElems(root)
	if n < 0 {
		return 0, "", false
	}
	return n, "nft_json", true
}

func walkNFTJSONCountElems(v interface{}) int {
	switch t := v.(type) {
	case map[string]interface{}:
		if elems, ok := t["elem"]; ok {
			if a, ok := elems.([]interface{}); ok {
				return len(a)
			}
		}
		if set, ok := t["set"]; ok {
			return walkNFTJSONCountElems(set)
		}
		for _, sub := range t {
			if n := walkNFTJSONCountElems(sub); n >= 0 {
				return n
			}
		}
	case []interface{}:
		for _, sub := range t {
			if n := walkNFTJSONCountElems(sub); n >= 0 {
				return n
			}
		}
	}
	return -1
}
