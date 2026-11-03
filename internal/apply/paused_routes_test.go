package apply

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

const pausedTestRoutes = `forwarding:
  routes:
    - proto: tcp
      ports: ["25565"]
      target_ip: 10.100.0.2
    - proto: udp
      ports: ["27015"]
      target_ip: 10.100.0.2
      pause_when_peer_offline: true
`

const (
	dnatRunning = "tcp dport 25565 dnat to 10.100.0.2"
	dnatPausing = "udp dport 27015 dnat to 10.100.0.2"
)

// fakeFirewall stands in for nft: `nft -f` makes a file's prerouting rules live, the way a table
// replace or a chain flush would, and `nft list chain` shows them.
type fakeFirewall struct {
	fakeRunner
	live    string
	loadErr error
}

func newFakeFirewall(t *testing.T) *fakeFirewall {
	t.Helper()
	fw := &fakeFirewall{}
	fw.handler = func(name string, args []string) ([]byte, error) {
		if name != "nft" {
			return nil, nil
		}
		switch {
		case len(args) == 2 && args[0] == "-f":
			if fw.loadErr != nil {
				return nil, fw.loadErr
			}
			b, err := os.ReadFile(args[1])
			if err != nil {
				return nil, err
			}
			_, rest, ok := strings.Cut(string(b), "type nat hook prerouting priority -100;\n")
			if !ok {
				t.Fatalf("nft -f of a file with no prerouting chain:\n%s", b)
			}
			fw.live, _, _ = strings.Cut(rest, "    }\n")
		case len(args) > 0 && args[0] == "list":
			if fw.live == "" {
				return nil, errors.New("No such file or directory")
			}
			return []byte(fw.live), nil
		case len(args) > 2 && args[0] == "-j":
			return nil, errors.New("no such set")
		}
		return nil, nil
	}
	return fw
}

func (fw *fakeFirewall) loads() int {
	n := 0
	for _, c := range fw.calls {
		if strings.HasPrefix(c, "nft -f") {
			n++
		}
	}
	return n
}

// appliedPausedConfig applies a config with one route that can pause (index 1) and one that can't.
func appliedPausedConfig(t *testing.T) (string, *fakeFirewall) {
	t.Helper()
	fw := newFakeFirewall(t)
	withFakeReloadEnv(t, &fw.fakeRunner, false)
	cfgPath := writeReloadTestConfig(t)
	writePausedRoutes(t, cfgPath, pausedTestRoutes)
	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v (calls %v)", err, fw.calls)
	}
	return cfgPath, fw
}

func writePausedRoutes(t *testing.T, cfgPath, routes string) {
	t.Helper()
	b, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	body := string(b)
	if before, _, ok := strings.Cut(body, "forwarding:\n"); ok {
		_, after, _ := strings.Cut(body, "peers:\n")
		body = before + routes + "peers:\n" + after
	}
	if err := os.WriteFile(cfgPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func pausedSet(indexes ...int) func(*config.Config) []int {
	return func(*config.Config) []int { return indexes }
}

func syncPaused(t *testing.T, cfgPath string, indexes ...int) {
	t.Helper()
	if err := SyncPausedRoutes(context.Background(), cfgPath, pausedSet(indexes...)); err != nil {
		t.Fatalf("sync %v: %v", indexes, err)
	}
}

func assertRoutes(t *testing.T, fw *fakeFirewall, running, paused []string, marked ...int) {
	t.Helper()
	for _, s := range running {
		if !strings.Contains(fw.live, s) {
			t.Fatalf("live chain lacks %q:\n%s", s, fw.live)
		}
	}
	for _, s := range paused {
		if strings.Contains(fw.live, s) {
			t.Fatalf("live chain still has %q:\n%s", s, fw.live)
		}
	}
	if got := gen.PausedRoutesIn(fw.live); !slices.Equal(got, marked) && (len(got) > 0 || len(marked) > 0) {
		t.Fatalf("paused routes in the live chain = %v, want %v", got, marked)
	}
}

func TestSyncPausedRoutes_pauseAndResume(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	all := []string{dnatRunning, dnatPausing}
	assertRoutes(t, fw, all, nil)

	fw.calls = nil
	syncPaused(t, cfgPath, 1)
	assertRoutes(t, fw, []string{dnatRunning}, []string{dnatPausing}, 1)
	if !strings.Contains(fw.live, `udp dport 27015 drop comment "evuproxy-paused:1"`) {
		t.Fatalf("the paused port isn't closed:\n%s", fw.live)
	}
	check, load := fw.callIndex("nft -c -f"), fw.callIndex("nft -f")
	if check < 0 || load < check {
		t.Fatalf("wrong order (validate=%d, load=%d): %v", check, load, fw.calls)
	}

	syncPaused(t, cfgPath)
	assertRoutes(t, fw, all, nil)
}

// Not a full reload: no table replace and nothing touching WireGuard.
func TestSyncPausedRoutes_noFullReload(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	genDir := filepath.Join(filepath.Dir(cfgPath), GeneratedDir)
	before, err := os.ReadFile(filepath.Join(genDir, "nftables.nft"))
	if err != nil {
		t.Fatal(err)
	}
	fw.calls = nil

	syncPaused(t, cfgPath, 1)

	for _, c := range fw.calls {
		if !strings.HasPrefix(c, "nft ") || strings.Contains(c, "apply.nft") {
			t.Fatalf("unexpected command %q in %v", c, fw.calls)
		}
	}
	update, err := os.ReadFile(filepath.Join(genDir, "paused-routes.nft"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(update), "delete table") || !strings.Contains(string(update), "flush chain ip evuproxy prerouting") {
		t.Fatalf("not a chain update:\n%s", update)
	}
	// The baseline the pending preview diffs against stays the plain config's ruleset.
	after, err := os.ReadFile(filepath.Join(genDir, "nftables.nft"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatalf("nftables.nft changed:\n%s", after)
	}
}

func TestSyncPausedRoutes_noChangeLoadsNothing(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	fw.calls = nil

	syncPaused(t, cfgPath)
	if n := fw.loads(); n != 0 {
		t.Fatalf("loaded %d times with nothing paused: %v", n, fw.calls)
	}
	syncPaused(t, cfgPath, 1)
	syncPaused(t, cfgPath, 1)
	if n := fw.loads(); n != 1 {
		t.Fatalf("loaded %d times for one pause: %v", n, fw.calls)
	}
}

// A full Apply renders every route from config and doesn't know about the pause. The next sync
// closes the route again, and the pending preview never sees the pause.
func TestSyncPausedRoutes_fullApplyWhilePaused(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	all := []string{dnatRunning, dnatPausing}
	syncPaused(t, cfgPath, 1)

	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v", err)
	}
	assertRoutes(t, fw, all, nil)

	syncPaused(t, cfgPath, 1)
	assertRoutes(t, fw, []string{dnatRunning}, []string{dnatPausing}, 1)

	info, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.NFTables != info.NFTablesBaseline {
		t.Fatalf("a pause shows up as a pending change:\n%s\nbaseline:\n%s", info.NFTables, info.NFTablesBaseline)
	}

	// And a resume after that Apply needs nothing from it.
	syncPaused(t, cfgPath)
	assertRoutes(t, fw, all, nil)
}

// An Apply can move routes. The paused set is asked for under the lock, against the new config.
func TestSyncPausedRoutes_fullApplyThatMovesARoute(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	syncPaused(t, cfgPath, 1)

	writePausedRoutes(t, cfgPath, `forwarding:
  routes:
    - proto: udp
      ports: ["27015"]
      target_ip: 10.100.0.2
      pause_when_peer_offline: true
    - proto: tcp
      ports: ["25565"]
      target_ip: 10.100.0.2
`)
	if err := Reload(context.Background(), cfgPath); err != nil {
		t.Fatalf("reload: %v", err)
	}
	err := SyncPausedRoutes(context.Background(), cfgPath, func(c *config.Config) []int {
		if !c.Forwarding.Routes[0].PauseWhenPeerOffline {
			t.Fatalf("given the old config: %+v", c.Forwarding.Routes)
		}
		return []int{0}
	})
	if err != nil {
		t.Fatal(err)
	}
	assertRoutes(t, fw, []string{dnatRunning}, []string{dnatPausing}, 0)
}

// serve restarted while a route was paused: every route starts as up, so the old pause goes.
func TestSyncPausedRoutes_restartRestoresAStalePause(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	syncPaused(t, cfgPath, 1)

	syncPaused(t, cfgPath)
	assertRoutes(t, fw, []string{dnatRunning, dnatPausing}, nil)
}

func TestSyncPausedRoutes_liveRulesFromAnotherConfig(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	nftPath := filepath.Join(filepath.Dir(cfgPath), GeneratedDir, "nftables.nft")
	if err := os.WriteFile(nftPath, []byte("# from a failed Apply\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	fw.calls = nil

	err := SyncPausedRoutes(context.Background(), cfgPath, pausedSet(1))
	if err == nil || !strings.Contains(err.Error(), "doesn't match the applied config") {
		t.Fatalf("err = %v", err)
	}
	if n := fw.loads(); n != 0 {
		t.Fatalf("loaded over a different ruleset: %v", fw.calls)
	}
	// With nothing to change, the mismatch doesn't matter.
	syncPaused(t, cfgPath)
}

func TestSyncPausedRoutes_noFirewallLoaded(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	fw.live = ""

	syncPaused(t, cfgPath)
	if err := SyncPausedRoutes(context.Background(), cfgPath, pausedSet(1)); err == nil {
		t.Fatal("a pause with no chain to change reported success")
	}
}

func TestSyncPausedRoutes_noAppliedConfig(t *testing.T) {
	fw := newFakeFirewall(t)
	withFakeReloadEnv(t, &fw.fakeRunner, false)
	cfgPath := writeReloadTestConfig(t)

	if err := SyncPausedRoutes(context.Background(), cfgPath, pausedSet(1)); err == nil {
		t.Fatal("expected an error with nothing applied")
	}
	if len(fw.calls) != 0 {
		t.Fatalf("ran commands: %v", fw.calls)
	}
}

func TestSyncPausedRoutes_failedLoadIsRetried(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	fw.loadErr = fmt.Errorf("netlink: Device or resource busy")

	if err := SyncPausedRoutes(context.Background(), cfgPath, pausedSet(1)); err == nil {
		t.Fatal("expected the load error")
	}
	assertRoutes(t, fw, []string{dnatRunning, dnatPausing}, nil)

	fw.loadErr = nil
	syncPaused(t, cfgPath, 1)
	assertRoutes(t, fw, []string{dnatRunning}, []string{dnatPausing}, 1)
}

func TestSyncPausedRoutes_lockBusyLeavesRulesForNextTime(t *testing.T) {
	cfgPath, fw := appliedPausedConfig(t)
	unlock, err := acquireApplyLock(context.Background(), cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	fw.calls = nil

	err = SyncPausedRoutes(context.Background(), cfgPath, func(*config.Config) []int {
		t.Fatal("asked for the paused set without the lock")
		return nil
	})
	unlock()
	if err != nil {
		t.Fatal(err)
	}
	if len(fw.calls) != 0 {
		t.Fatalf("ran commands: %v", fw.calls)
	}
	syncPaused(t, cfgPath, 1)
	assertRoutes(t, fw, []string{dnatRunning}, []string{dnatPausing}, 1)
}
