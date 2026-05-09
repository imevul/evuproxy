package metrics

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
)

func TestWriteReadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "m.db")
	db, err := OpenWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0).UTC()
	results := []apply.PeerPingResult{
		{Name: "a", TunnelIP: "10.0.0.2", OK: true, LatencyMS: 12},
		{Name: "b", TunnelIP: "10.0.0.3", OK: true, LatencyMS: 22},
	}
	if err := WriteResults(context.Background(), db, results, now); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	db2, err := OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	resp, err := BuildPeersResponse(context.Background(), db2, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Peers) != 2 {
		t.Fatalf("peers %d", len(resp.Peers))
	}
	if resp.Dashboard == nil || resp.Dashboard.LastPing == nil {
		t.Fatal("expected last_ping")
	}
	if resp.Dashboard.LastPing.MinMS != 12 || resp.Dashboard.LastPing.MaxMS != 22 || resp.Dashboard.LastPing.AvgMS != 17 {
		t.Fatalf("last_ping %+v", resp.Dashboard.LastPing)
	}
}

func TestLast10mPeerSmoothed(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "m.db")
	db, err := OpenWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	base := time.Now().UTC().Add(-5 * time.Minute)
	if err := WriteResults(context.Background(), db, []apply.PeerPingResult{
		{Name: "a", TunnelIP: "10.0.0.2", OK: true, LatencyMS: 10},
		{Name: "b", TunnelIP: "10.0.0.3", OK: true, LatencyMS: 30},
	}, base); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := WriteResults(context.Background(), db, []apply.PeerPingResult{
		{Name: "a", TunnelIP: "10.0.0.2", OK: true, LatencyMS: 20},
		{Name: "b", TunnelIP: "10.0.0.3", OK: true, LatencyMS: 40},
	}, base.Add(2*time.Minute)); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db2, err := OpenReader(path)
	if err != nil {
		t.Fatal(err)
	}
	defer db2.Close()
	resp, err := BuildPeersResponse(context.Background(), db2, false)
	if err != nil {
		t.Fatal(err)
	}
	if resp.Dashboard.Last10m == nil {
		t.Fatal("expected last_10m")
	}
	// peer a mean 15, peer b mean 35 -> min 15 max 35 avg 25
	if resp.Dashboard.Last10m.MinMS != 15 || resp.Dashboard.Last10m.MaxMS != 35 || resp.Dashboard.Last10m.AvgMS != 25 {
		t.Fatalf("last_10m %+v", resp.Dashboard.Last10m)
	}
}
