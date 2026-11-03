package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/imevul/evuproxy/internal/metrics"
	"github.com/imevul/evuproxy/internal/state"
)

// stubPing installs a ping that appends a line to the returned file on every call.
func stubPing(t *testing.T) (callsFile string) {
	t.Helper()
	callsFile = filepath.Join(t.TempDir(), "ping-calls")
	stubTools(t, map[string]string{
		"ping": `echo call >> "` + callsFile + `"; echo "64 bytes from $5: icmp_seq=1 ttl=64 time=7.2 ms"`,
	})
	return callsFile
}

func pingCalls(t *testing.T, callsFile string) int {
	t.Helper()
	b, err := os.ReadFile(callsFile)
	if os.IsNotExist(err) {
		return 0
	}
	if err != nil {
		t.Fatal(err)
	}
	return strings.Count(string(b), "call\n")
}

func setMetricsEnabled(t *testing.T, cfg string, enabled bool) {
	t.Helper()
	if err := state.SaveUIPreferences(cfg, &state.UIPreferences{MetricsCollectionEnabled: enabled}); err != nil {
		t.Fatal(err)
	}
}

// runLoopFor runs the loop for d and fails if it does not stop when its context ends.
func runLoopFor(t *testing.T, cfg, db string, interval, d time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), d)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runMetricsLoop(ctx, cfg, db, interval) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(d + 30*time.Second):
		t.Fatal("loop did not stop after its context ended")
	}
}

func storedPeers(t *testing.T, db string) []metrics.PeerMetric {
	t.Helper()
	r, err := metrics.OpenReader(db)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	resp, err := metrics.BuildPeersResponse(context.Background(), r, false)
	if err != nil {
		t.Fatal(err)
	}
	return resp.Peers
}

func TestMetricsLoop_collectsWhenEnabled(t *testing.T) {
	stubPing(t)
	cfg := writeTestConfig(t)
	setMetricsEnabled(t, cfg, true)
	db := filepath.Join(t.TempDir(), "m.sqlite")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runMetricsLoop(ctx, cfg, db, time.Minute) }()

	// The first round runs at startup, without waiting for the interval.
	var peers []metrics.PeerMetric
	deadline := time.Now().Add(20 * time.Second)
	for len(peers) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("no metrics written")
		}
		time.Sleep(50 * time.Millisecond)
		r, err := metrics.OpenReader(db)
		if err != nil {
			continue
		}
		if resp, err := metrics.BuildPeersResponse(ctx, r, false); err == nil {
			peers = resp.Peers
		}
		_ = r.Close()
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}

	if len(peers) != 2 {
		t.Fatalf("peers: %+v", peers)
	}
	for _, p := range peers {
		if !p.OK || p.LatencyMS != 7 {
			t.Fatalf("peer: %+v", p)
		}
	}
}

func TestMetricsLoop_respectsDisabledPreference(t *testing.T) {
	calls := stubPing(t)
	cfg := writeTestConfig(t)
	setMetricsEnabled(t, cfg, false)
	db := filepath.Join(t.TempDir(), "m.sqlite")

	runLoopFor(t, cfg, db, time.Minute, time.Second)

	if n := pingCalls(t, calls); n != 0 {
		t.Fatalf("ping ran %d times while disabled", n)
	}
	if peers := storedPeers(t, db); len(peers) != 0 {
		t.Fatalf("peers: %+v", peers)
	}
}

func TestMetricsLoop_defaultsToDisabledWithoutPreferences(t *testing.T) {
	calls := stubPing(t)
	cfg := writeTestConfig(t)

	runLoopFor(t, cfg, filepath.Join(t.TempDir(), "m.sqlite"), time.Minute, time.Second)

	if n := pingCalls(t, calls); n != 0 {
		t.Fatalf("ping ran %d times without opting in", n)
	}
}

func TestMetricsLoop_rereadsPreferencesEachRound(t *testing.T) {
	// The first round is disabled and the floor is 5s, so this waits for one real tick.
	if testing.Short() {
		t.Skip("waits for the 5s interval floor")
	}
	calls := stubPing(t)
	cfg := writeTestConfig(t)
	setMetricsEnabled(t, cfg, false)
	db := filepath.Join(t.TempDir(), "m.sqlite")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- runMetricsLoop(ctx, cfg, db, 5*time.Second) }()

	time.Sleep(500 * time.Millisecond)
	if n := pingCalls(t, calls); n != 0 {
		t.Fatalf("ping ran %d times while disabled", n)
	}
	setMetricsEnabled(t, cfg, true)

	deadline := time.Now().Add(30 * time.Second)
	for pingCalls(t, calls) == 0 {
		if time.Now().After(deadline) {
			t.Fatal("enabling metrics did not take effect without a restart")
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func TestMetricsLoop_shortIntervalIsClampedToFloor(t *testing.T) {
	calls := stubPing(t)
	cfg := writeTestConfig(t)
	setMetricsEnabled(t, cfg, true)

	runLoopFor(t, cfg, filepath.Join(t.TempDir(), "m.sqlite"), time.Millisecond, time.Second)

	// Only the startup round fits in a second: at most one ping for each of the two
	// peers. A slow machine may manage fewer, but a 1ms ticker would run far more.
	if n := pingCalls(t, calls); n > 2 {
		t.Fatalf("ping ran %d times, want at most 2", n)
	}
}

func TestMetricsLoop_keepsRunningOnBadPreferences(t *testing.T) {
	calls := stubPing(t)
	cfg := writeTestConfig(t)
	if err := os.WriteFile(filepath.Join(filepath.Dir(cfg), "ui-preferences.json"), []byte("{broken"), 0o644); err != nil {
		t.Fatal(err)
	}

	runLoopFor(t, cfg, filepath.Join(t.TempDir(), "m.sqlite"), time.Minute, 200*time.Millisecond)

	if n := pingCalls(t, calls); n != 0 {
		t.Fatalf("ping ran %d times with unreadable preferences", n)
	}
}

func TestMetricsLoop_unusableDatabaseFails(t *testing.T) {
	stubTools(t, nil)
	notADir := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(notADir, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	err := runMetricsLoop(context.Background(), writeTestConfig(t), filepath.Join(notADir, "m.sqlite"), time.Minute)
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestMetricsCmd_defaultDatabaseIsBesideConfig(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the loop returns as soon as its startup round is done

	if res := runCLI(t, ctx, "metrics", "--config", cfg); res.err != nil {
		t.Fatalf("%v\nstderr: %s", res.err, res.stderr)
	}

	if _, err := os.Stat(state.MetricsDBDefaultPath(cfg)); err != nil {
		t.Fatal(err)
	}
}

func TestMetricsCmd_dbFlagOverridesDefault(t *testing.T) {
	stubTools(t, nil)
	cfg := writeTestConfig(t)
	db := filepath.Join(t.TempDir(), "custom.sqlite")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	if res := runCLI(t, ctx, "metrics", "--config", cfg, "--db", db); res.err != nil {
		t.Fatalf("%v\nstderr: %s", res.err, res.stderr)
	}

	if _, err := os.Stat(db); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(state.MetricsDBDefaultPath(cfg)); !os.IsNotExist(err) {
		t.Fatalf("default database created too: %v", err)
	}
}
