package metrics

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/imevul/evuproxy/internal/apply"
)

// ErrSchemaNotReady means the metrics file exists but has not been initialized by the worker yet.
var ErrSchemaNotReady = errors.New("metrics schema not initialized")

const driverName = "sqlite"

// MinAvgMax is a latency aggregate for the overview dashboard.
type MinAvgMax struct {
	MinMS int64 `json:"min_ms"`
	AvgMS int64 `json:"avg_ms"`
	MaxMS int64 `json:"max_ms"`
}

// Last10mDashboard is peer-smoothed min/avg/max over a 10-minute window (plan strategy B).
type Last10mDashboard struct {
	MinAvgMax
	WindowStartUTC string `json:"window_start_utc"`
	WindowEndUTC   string `json:"window_end_utc"`
}

// Dashboard wraps optional overview aggregates.
type Dashboard struct {
	LastPing *MinAvgMax        `json:"last_ping,omitempty"`
	Last10m  *Last10mDashboard `json:"last_10m,omitempty"`
}

// PeerMetric is one peer's latest stored metrics (API row).
type PeerMetric struct {
	Name      string `json:"name"`
	TunnelIP  string `json:"tunnel_ip"`
	OK        bool   `json:"ok"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
	Error     string `json:"error,omitempty"`
	TsUTC     string `json:"ts_utc,omitempty"`
}

// PeersResponse is the JSON body for GET /api/v1/metrics/peers.
type PeersResponse struct {
	CollectionDisabled bool         `json:"collection_disabled"`
	CollectedAtUTC     string       `json:"collected_at_utc,omitempty"`
	Peers              []PeerMetric `json:"peers"`
	Dashboard          *Dashboard   `json:"dashboard,omitempty"`
}

func dsnWriter(path string) string {
	p := filepath.ToSlash(path)
	return fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)", p)
}

func dsnReader(path string) string {
	p := filepath.ToSlash(path)
	return fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", p)
}

// OpenWriter opens the metrics DB for read-write (metrics worker only).
func OpenWriter(path string) (*sql.DB, error) {
	dir := filepath.Dir(path)
	if dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o750); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open(driverName, dsnWriter(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if err := migrate(db); err != nil {
		_ = db.Close()
		return nil, err
	}
	return db, nil
}

// OpenReader opens the metrics DB read-only (API server).
func OpenReader(path string) (*sql.DB, error) {
	db, err := sql.Open(driverName, dsnReader(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(4)
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, err
	}
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		_ = db.Close()
		return nil, err
	}
	if v < 1 {
		_ = db.Close()
		return nil, ErrSchemaNotReady
	}
	return db, nil
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v >= 1 {
		return nil
	}
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS peer_latest (
			tunnel_ip TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			ok INTEGER NOT NULL,
			latency_ms INTEGER,
			err_text TEXT,
			ts_utc TEXT NOT NULL
		)`,
		`CREATE TABLE IF NOT EXISTS peer_sample (
			ts_ms INTEGER NOT NULL,
			tunnel_ip TEXT NOT NULL,
			latency_ms INTEGER NOT NULL,
			PRIMARY KEY (ts_ms, tunnel_ip)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_peer_sample_ts ON peer_sample(ts_ms)`,
		`PRAGMA user_version = 1`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			return fmt.Errorf("metrics migrate: %w", err)
		}
	}
	return nil
}

func nullIfEmpty(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// WriteResults stores one collection tick: replaces peer_latest entirely (so removed/disabled peers disappear),
// appends ok samples for the time series, prunes old samples.
func WriteResults(ctx context.Context, db *sql.DB, results []apply.PeerPingResult, tickUTC time.Time) error {
	tsMs := tickUTC.UnixMilli()
	tsStr := tickUTC.UTC().Format(time.RFC3339)
	cutoffMs := tickUTC.Add(-15 * time.Minute).UnixMilli()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `DELETE FROM peer_latest`); err != nil {
		return err
	}

	const insLatest = `INSERT INTO peer_latest(tunnel_ip,name,ok,latency_ms,err_text,ts_utc) VALUES(?,?,?,?,?,?)`
	const insSample = `INSERT OR REPLACE INTO peer_sample(ts_ms,tunnel_ip,latency_ms) VALUES(?,?,?)`

	for _, r := range results {
		ip := strings.TrimSpace(r.TunnelIP)
		if ip == "" {
			continue
		}
		var lat sql.NullInt64
		if r.OK {
			lat = sql.NullInt64{Int64: r.LatencyMS, Valid: true}
		}
		ok := 0
		if r.OK {
			ok = 1
		}
		if _, err := tx.ExecContext(ctx, insLatest, ip, r.Name, ok, lat, nullIfEmpty(r.Error), tsStr); err != nil {
			return err
		}
		if r.OK {
			if _, err := tx.ExecContext(ctx, insSample, tsMs, ip, r.LatencyMS); err != nil {
				return err
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM peer_sample WHERE ts_ms < ?`, cutoffMs); err != nil {
		return err
	}
	return tx.Commit()
}
