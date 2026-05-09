package metrics

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
)

func TestWriteResultsClearsPeerLatestWhenEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "m.db")
	db, err := OpenWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0).UTC()
	if err := WriteResults(context.Background(), db, []apply.PeerPingResult{
		{Name: "a", TunnelIP: "10.0.0.2", OK: true, LatencyMS: 1},
	}, now); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	if err := WriteResults(context.Background(), db, nil, now.Add(time.Minute)); err != nil {
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
	if len(resp.Peers) != 0 {
		t.Fatalf("want empty peer_latest, got %d rows", len(resp.Peers))
	}
}
