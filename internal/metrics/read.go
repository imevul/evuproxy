package metrics

import (
	"context"
	"database/sql"
	"math"
	"time"
)

// BuildPeersResponse reads the DB and builds the API payload. db may be nil (empty response).
// collectionDisabled comes from live UI preferences.
func BuildPeersResponse(ctx context.Context, db *sql.DB, collectionDisabled bool) (*PeersResponse, error) {
	out := &PeersResponse{
		CollectionDisabled: collectionDisabled,
		Peers:              []PeerMetric{},
	}
	if db == nil {
		return out, nil
	}
	rows, err := db.QueryContext(ctx,
		`SELECT tunnel_ip, name, ok, latency_ms, err_text, ts_utc FROM peer_latest ORDER BY name, tunnel_ip`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var maxCollected time.Time
	for rows.Next() {
		var ip, name, ts string
		var okInt int
		var lat sql.NullInt64
		var errText sql.NullString
		if err := rows.Scan(&ip, &name, &okInt, &lat, &errText, &ts); err != nil {
			return nil, err
		}
		pm := PeerMetric{Name: name, TunnelIP: ip, TsUTC: ts}
		if okInt != 0 {
			pm.OK = true
			if lat.Valid {
				pm.LatencyMS = lat.Int64
			}
		} else {
			if errText.Valid {
				pm.Error = errText.String
			}
		}
		out.Peers = append(out.Peers, pm)
		if t, perr := time.Parse(time.RFC3339, ts); perr == nil {
			if maxCollected.IsZero() || t.After(maxCollected) {
				maxCollected = t
			}
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if !maxCollected.IsZero() {
		out.CollectedAtUTC = maxCollected.UTC().Format(time.RFC3339)
	}

	now := time.Now().UTC()
	endMs := now.UnixMilli()
	startMs := now.Add(-10 * time.Minute).UnixMilli()
	winStart := time.UnixMilli(startMs).UTC().Format(time.RFC3339)
	winEnd := time.UnixMilli(endMs).UTC().Format(time.RFC3339)

	dash := &Dashboard{}
	if lp := lastPingAgg(out.Peers); lp != nil {
		dash.LastPing = lp
	}
	if l10 := last10mPeerSmoothed(ctx, db, startMs, endMs, winStart, winEnd); l10 != nil {
		dash.Last10m = l10
	}
	if ph := pingHistorySeries(ctx, db, now.Add(-15*time.Minute).UnixMilli(), endMs); len(ph) > 0 {
		dash.PingHistory = ph
	}
	if dash.LastPing != nil || dash.Last10m != nil || len(dash.PingHistory) > 0 {
		out.Dashboard = dash
	}
	return out, nil
}

func lastPingAgg(peers []PeerMetric) *MinAvgMax {
	var vals []int64
	for _, p := range peers {
		if p.OK {
			vals = append(vals, p.LatencyMS)
		}
	}
	if len(vals) == 0 {
		return nil
	}
	return minAvgMaxInts(vals)
}

func minAvgMaxInts(vals []int64) *MinAvgMax {
	var minV, maxV int64 = vals[0], vals[0]
	var sum int64
	for _, v := range vals {
		if v < minV {
			minV = v
		}
		if v > maxV {
			maxV = v
		}
		sum += v
	}
	avg := int64(math.Round(float64(sum) / float64(len(vals))))
	return &MinAvgMax{MinMS: minV, AvgMS: avg, MaxMS: maxV}
}

func last10mPeerSmoothed(ctx context.Context, db *sql.DB, startMs, endMs int64, winStartRFC, winEndRFC string) *Last10mDashboard {
	const q = `
WITH means AS (
  SELECT tunnel_ip, CAST(AVG(latency_ms) AS REAL) AS m FROM peer_sample
  WHERE ts_ms >= ? AND ts_ms <= ?
  GROUP BY tunnel_ip
)
SELECT MIN(m), AVG(m), MAX(m) FROM means`
	var minN, avgN, maxN sql.NullFloat64
	err := db.QueryRowContext(ctx, q, startMs, endMs).Scan(&minN, &avgN, &maxN)
	if err != nil {
		return nil
	}
	if !minN.Valid || !avgN.Valid || !maxN.Valid {
		return nil
	}
	return &Last10mDashboard{
		MinAvgMax: MinAvgMax{
			MinMS: int64(math.Round(minN.Float64)),
			AvgMS: int64(math.Round(avgN.Float64)),
			MaxMS: int64(math.Round(maxN.Float64)),
		},
		WindowStartUTC: winStartRFC,
		WindowEndUTC:   winEndRFC,
	}
}

func pingHistorySeries(ctx context.Context, db *sql.DB, startMs, endMs int64) []PingHistoryPoint {
	if db == nil || endMs <= startMs {
		return nil
	}
	const bucketMs = int64(60_000)
	rows, err := db.QueryContext(ctx, `
SELECT ((ts_ms / ?) * ?) AS b, AVG(latency_ms)
FROM peer_sample
WHERE ts_ms >= ? AND ts_ms <= ?
GROUP BY b
ORDER BY b ASC`, bucketMs, bucketMs, startMs, endMs)
	if err != nil {
		return nil
	}
	defer rows.Close()
	var out []PingHistoryPoint
	for rows.Next() {
		var b int64
		var avg sql.NullFloat64
		if err := rows.Scan(&b, &avg); err != nil {
			return nil
		}
		if !avg.Valid {
			continue
		}
		out = append(out, PingHistoryPoint{
			TsUTC: time.UnixMilli(b).UTC().Format(time.RFC3339),
			AvgMs: int64(math.Round(avg.Float64)),
		})
	}
	if err := rows.Err(); err != nil {
		return nil
	}
	return out
}
