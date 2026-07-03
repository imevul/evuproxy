package observability

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

// PeerOnlineMaxHandshakeAgeSec matches the admin UI peers table (3 minutes).
const PeerOnlineMaxHandshakeAgeSec = 180

// PrometheusText builds Prometheus exposition format for EvuProxy host metrics.
func PrometheusText(cfgPath string) ([]byte, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	st, _ := apply.StatsFromHost(cfgPath)
	geo := state.ReadGeoLastSuccess(cfgPath)

	var b strings.Builder
	writeCounter(&b, "evuproxy_apply_success_total", "Successful reload or update-geo apply operations (persisted beside config)", state.ApplySuccessTotal(cfgPath))
	writeCounter(&b, "evuproxy_apply_failure_total", "Failed reload or update-geo apply operations (persisted beside config)", state.ApplyFailureTotal(cfgPath))

	geoTS := 0.0
	if geo.UTC != "" {
		if t, err := time.Parse(time.RFC3339, geo.UTC); err == nil {
			geoTS = float64(t.Unix())
		}
	}
	writeGauge(&b, "evuproxy_geo_last_success_timestamp_seconds", "Unix time of last successful geo zone load (0 if never)", geoTS)

	maint := 0.0
	if c.Forwarding.MaintenanceMode {
		maint = 1
	}
	writeGauge(&b, "evuproxy_maintenance_mode", "1 when forwarding.maintenance_mode is enabled in config", maint)

	online := countPeersOnline(st, time.Now().Unix())
	writeGauge(&b, "evuproxy_peers_online", "Peers with WireGuard handshake within 180 seconds", float64(online))

	return []byte(b.String()), nil
}

func countPeersOnline(st *apply.Stats, nowUnix int64) int {
	if st == nil || st.WireGuardDumpFailed {
		return 0
	}
	n := 0
	for _, p := range st.WireGuardPeers {
		if p.LatestHandshake <= 0 {
			continue
		}
		if nowUnix-p.LatestHandshake <= PeerOnlineMaxHandshakeAgeSec {
			n++
		}
	}
	return n
}

func writeCounter(b *strings.Builder, name, help string, v uint64) {
	b.WriteString("# HELP ")
	b.WriteString(name)
	b.WriteString(" ")
	b.WriteString(help)
	b.WriteString("\n# TYPE ")
	b.WriteString(name)
	b.WriteString(" counter\n")
	b.WriteString(name)
	b.WriteString(" ")
	b.WriteString(strconv.FormatUint(v, 10))
	b.WriteString("\n")
}

func writeGauge(b *strings.Builder, name, help string, v float64) {
	b.WriteString("# HELP ")
	b.WriteString(name)
	b.WriteString(" ")
	b.WriteString(help)
	b.WriteString("\n# TYPE ")
	b.WriteString(name)
	b.WriteString(" gauge\n")
	b.WriteString(name)
	b.WriteString(" ")
	b.WriteString(formatFloat(v))
	b.WriteString("\n")
}

func formatFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}

// ValidateMetricsListen warns when listen is not loopback-only.
func ValidateMetricsListen(listen string) error {
	listen = strings.TrimSpace(listen)
	if listen == "" {
		return nil
	}
	host, _, err := splitHostPort(listen)
	if err != nil {
		return err
	}
	if host != "127.0.0.1" && host != "::1" && host != "localhost" {
		return fmt.Errorf("metrics listen address %q is not loopback — bind 127.0.0.1 only unless you accept unauthenticated scrape exposure", listen)
	}
	return nil
}

func splitHostPort(addr string) (host, port string, err error) {
	if strings.HasPrefix(addr, "[") {
		i := strings.LastIndex(addr, "]")
		if i < 0 {
			return "", "", fmt.Errorf("invalid listen address %q", addr)
		}
		host = addr[1:i]
		rest := strings.TrimPrefix(addr[i+1:], ":")
		return host, rest, nil
	}
	parts := strings.Split(addr, ":")
	if len(parts) == 1 {
		return parts[0], "", nil
	}
	return strings.Join(parts[:len(parts)-1], ":"), parts[len(parts)-1], nil
}
