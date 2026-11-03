package autopause

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
)

const (
	keyA = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
	keyB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="
	ipA  = "10.100.0.2"
	ipB  = "10.100.0.3"
)

var testNow = time.Unix(1_800_000_000, 0)

func testConfig() *config.Config {
	return &config.Config{
		WireGuard: config.WireGuard{Interface: "wg0"},
		Peers: []config.Peer{
			{Name: "a", PublicKey: keyA, TunnelIP: ipA + "/32"},
			{Name: "b", PublicKey: keyB, TunnelIP: ipB + "/32"},
		},
		Forwarding: config.Forwarding{Routes: []config.ForwardRoute{
			{Proto: "tcp", Ports: []string{"25565"}, TargetIP: ipA, PauseWhenPeerOffline: true},
		}},
	}
}

// fakeProber is driven by peer: set a fresh or stale handshake, and which IPs answer ping.
type fakeProber struct {
	mu             sync.Mutex
	handshakes     map[string]int64
	handshakeErr   error
	handshakeCalls int
	replies        map[string]bool
	pinged         []string
}

func newFakeProber() *fakeProber {
	return &fakeProber{handshakes: map[string]int64{}, replies: map[string]bool{}}
}

func (f *fakeProber) Handshakes(string) (map[string]int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.handshakeCalls++
	return f.handshakes, f.handshakeErr
}

func (f *fakeProber) Ping(_ context.Context, ip string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.pinged = append(f.pinged, ip)
	if f.replies[ip] {
		return nil
	}
	return errors.New("no reply")
}

func (f *fakeProber) online(key string)  { f.handshakes[key] = testNow.Unix() - 10 }
func (f *fakeProber) offline(key string) { f.handshakes[key] = testNow.Unix() - 600 }

func newLoop(c *config.Config, p Prober) *Loop {
	return &Loop{
		Load:   func() (*config.Config, error) { return c, nil },
		Prober: p,
		Now:    func() time.Time { return testNow },
	}
}

func tickN(l *Loop, n int) {
	for range n {
		l.Tick(context.Background())
	}
}

func TestHysteresis_defaultThresholds(t *testing.T) {
	p := newFakeProber()
	l := newLoop(testConfig(), p)

	p.offline(keyA)
	tickN(l, 2)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("paused after 2 failures: %v", got)
	}
	tickN(l, 1)
	got := l.PausedRoutes()
	if len(got) != 1 || got[0].TargetIP != ipA || got[0].Peer != "a" {
		t.Fatalf("want route paused after 3 failures, got %v", got)
	}

	p.online(keyA)
	tickN(l, 1)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("resumed after only 1 success")
	}
	tickN(l, 1)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("still paused after 2 successes: %v", got)
	}
}

func TestHysteresis_configuredThresholds(t *testing.T) {
	c := testConfig()
	c.AutoPause = config.AutoPause{FailuresToPause: 1, SuccessesToResume: 3}
	p := newFakeProber()
	l := newLoop(c, p)

	p.offline(keyA)
	tickN(l, 1)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("want paused after 1 failure")
	}
	p.online(keyA)
	tickN(l, 2)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("resumed before 3 successes")
	}
	tickN(l, 1)
	if len(l.PausedRoutes()) != 0 {
		t.Fatal("want resumed after 3 successes")
	}
}

func TestFlapping_onlinePeerNeverPauses(t *testing.T) {
	p := newFakeProber()
	l := newLoop(testConfig(), p)
	for range 10 {
		p.offline(keyA)
		tickN(l, 2)
		p.online(keyA)
		tickN(l, 1)
		if got := l.PausedRoutes(); len(got) != 0 {
			t.Fatalf("flapping peer paused without 3 consecutive failures: %v", got)
		}
	}
}

func TestFlapping_pausedPeerNeverResumes(t *testing.T) {
	p := newFakeProber()
	l := newLoop(testConfig(), p)
	p.offline(keyA)
	tickN(l, 3)
	for range 10 {
		p.online(keyA)
		tickN(l, 1)
		p.offline(keyA)
		tickN(l, 1)
		if len(l.PausedRoutes()) != 1 {
			t.Fatal("flapping peer resumed without 2 consecutive successes")
		}
	}
}

func TestFlapping_oneTransitionPerEvent(t *testing.T) {
	var events []string
	p := newFakeProber()
	l := newLoop(testConfig(), p)
	l.Emit = func(r eventlog.Record) { events = append(events, r.Event) }
	changes := 0
	l.OnChange = func([]PausedRoute) { changes++ }

	p.offline(keyA)
	tickN(l, 6)
	p.online(keyA)
	tickN(l, 6)
	if len(events) != 2 || events[0] != "route_auto_paused" || events[1] != "route_auto_resumed" {
		t.Fatalf("events = %v", events)
	}
	if changes != 2 {
		t.Fatalf("OnChange calls = %d, want 2", changes)
	}
}

func TestRestart_startsUpAndNeedsFullThreshold(t *testing.T) {
	c := testConfig()
	p := newFakeProber()
	p.offline(keyA)
	before := newLoop(c, p)
	tickN(before, 3)
	if len(before.PausedRoutes()) != 1 {
		t.Fatal("setup: want paused")
	}

	// A new Loop is what a process restart gives: no state is carried over.
	after := newLoop(c, p)
	if got := after.PausedRoutes(); len(got) != 0 {
		t.Fatalf("paused before any probe: %v", got)
	}
	tickN(after, 2)
	if got := after.PausedRoutes(); len(got) != 0 {
		t.Fatalf("paused below threshold after restart: %v", got)
	}
	tickN(after, 1)
	if len(after.PausedRoutes()) != 1 {
		t.Fatal("want paused again once the threshold is reached")
	}
}

func TestRun_waitsOneIntervalBeforeFirstProbe(t *testing.T) {
	c := testConfig()
	c.AutoPause.Interval = "20s"
	p := newFakeProber()
	p.online(keyA)
	l := newLoop(c, p)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var waits []time.Duration
	var callsAtFirstWait int
	l.wait = func(_ context.Context, d time.Duration) bool {
		if len(waits) == 0 {
			callsAtFirstWait = p.handshakeCalls
		}
		waits = append(waits, d)
		if len(waits) == 2 {
			c.AutoPause.Interval = "30s" // picked up on the next tick
		}
		return len(waits) < 4
	}
	l.Run(ctx)
	if callsAtFirstWait != 0 {
		t.Fatalf("probed %d times before the first interval", callsAtFirstWait)
	}
	want := []time.Duration{20 * time.Second, 20 * time.Second, 30 * time.Second, 30 * time.Second}
	for i := range want {
		if waits[i] != want[i] {
			t.Fatalf("waits = %v, want %v", waits, want)
		}
	}
}

func TestOptIn_routesWithoutSettingAreNotProbed(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes[0].PauseWhenPeerOffline = false
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 5)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("paused without the setting: %v", got)
	}
	if p.handshakeCalls != 0 {
		t.Fatalf("read handshakes %d times with no route opted in", p.handshakeCalls)
	}
}

func TestOptIn_onlyFlaggedRoutesOnSamePeerPause(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes = append(c.Forwarding.Routes,
		config.ForwardRoute{Proto: "udp", Ports: []string{"27015"}, TargetIP: ipA},
		config.ForwardRoute{Proto: "tcp", Ports: []string{"8080"}, TargetIP: ipA, PauseWhenPeerOffline: true},
	)
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 3)
	got := l.PausedRoutes()
	if len(got) != 2 || got[0].Ports[0] != "25565" || got[1].Ports[0] != "8080" {
		t.Fatalf("paused = %v", got)
	}
}

func TestDisabledRoute_neverPausedOrResumed(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes[0].Disabled = true
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 5)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("disabled route reported as auto-paused: %v", got)
	}
	if !c.Forwarding.Routes[0].Disabled {
		t.Fatal("loop changed disabled")
	}
}

func TestPausedRoute_userDisablesThenPeerReturns(t *testing.T) {
	c := testConfig()
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 3)

	c.Forwarding.Routes[0].Disabled = true
	p.online(keyA)
	tickN(l, 3)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("disabled route still listed: %v", got)
	}
	if !c.Forwarding.Routes[0].Disabled {
		t.Fatal("resume re-enabled a route the user disabled")
	}
}

func TestSettingTurnedOff_clearsState(t *testing.T) {
	c := testConfig()
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 3)

	c.Forwarding.Routes[0].PauseWhenPeerOffline = false
	tickN(l, 1)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("still paused after opting out: %v", got)
	}

	// Opting back in starts from "up" again.
	c.Forwarding.Routes[0].PauseWhenPeerOffline = true
	tickN(l, 2)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("old failures carried over: %v", got)
	}
}

func TestHandshake_boundary(t *testing.T) {
	cases := []struct {
		name   string
		age    int64
		online bool
	}{
		{"at threshold", 180, true},
		{"past threshold", 181, false},
		{"clock skew", -5, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := testConfig()
			c.AutoPause.FailuresToPause = 1
			p := newFakeProber()
			p.handshakes[keyA] = testNow.Unix() - tc.age
			l := newLoop(c, p)
			tickN(l, 1)
			if paused := len(l.PausedRoutes()) == 1; paused == tc.online {
				t.Fatalf("age %d: paused = %v", tc.age, paused)
			}
		})
	}
}

func TestHandshake_neverSeenCountsAsFailure(t *testing.T) {
	p := newFakeProber()
	p.handshakes[keyA] = 0
	l := newLoop(testConfig(), p)
	tickN(l, 3)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("zero handshake should count as offline")
	}

	missing := newLoop(testConfig(), newFakeProber())
	tickN(missing, 3)
	if len(missing.PausedRoutes()) != 1 {
		t.Fatal("peer absent from dump should count as offline")
	}
}

func TestHandshakeReadError_notCounted(t *testing.T) {
	p := newFakeProber()
	p.handshakeErr = errors.New("wg: permission denied")
	l := newLoop(testConfig(), p)
	tickN(l, 10)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("paused on a read error: %v", got)
	}

	// A failed read also doesn't break a run: 2 failures + error + 1 failure pauses.
	p.handshakeErr = nil
	p.offline(keyA)
	tickN(l, 2)
	p.handshakeErr = errors.New("wg: gone")
	tickN(l, 1)
	p.handshakeErr = nil
	tickN(l, 1)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("want paused after 3 counted failures")
	}

	// And a paused route stays paused while the signal is unavailable.
	p.handshakeErr = errors.New("wg: gone")
	tickN(l, 5)
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("resumed on a read error")
	}
}

func TestLoadError_keepsState(t *testing.T) {
	c := testConfig()
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	tickN(l, 3)

	l.Load = func() (*config.Config, error) { return nil, errors.New("bad yaml") }
	if next := l.Tick(context.Background()); next != 0 {
		t.Fatalf("interval = %v, want 0 on load error", next)
	}
	if len(l.PausedRoutes()) != 1 {
		t.Fatal("state lost on a config read error")
	}
}

func TestICMPFallback(t *testing.T) {
	t.Run("off by default: stale handshake fails without pinging", func(t *testing.T) {
		p := newFakeProber()
		p.offline(keyA)
		p.replies[ipA] = true
		l := newLoop(testConfig(), p)
		tickN(l, 3)
		if len(l.PausedRoutes()) != 1 {
			t.Fatal("want paused")
		}
		if len(p.pinged) != 0 {
			t.Fatalf("pinged %v with fallback off", p.pinged)
		}
	})
	t.Run("on: fresh handshake is not pinged", func(t *testing.T) {
		c := testConfig()
		c.AutoPause.ICMPFallback = true
		p := newFakeProber()
		p.online(keyA)
		l := newLoop(c, p)
		tickN(l, 3)
		if len(p.pinged) != 0 {
			t.Fatalf("pinged a healthy peer: %v", p.pinged)
		}
	})
	t.Run("on: reply rescues an idle peer", func(t *testing.T) {
		c := testConfig()
		c.AutoPause.ICMPFallback = true
		p := newFakeProber()
		p.offline(keyA)
		p.replies[ipA] = true
		l := newLoop(c, p)
		tickN(l, 5)
		if got := l.PausedRoutes(); len(got) != 0 {
			t.Fatalf("paused despite ping replies: %v", got)
		}
	})
	t.Run("on: no reply counts as a failure", func(t *testing.T) {
		c := testConfig()
		c.AutoPause.ICMPFallback = true
		p := newFakeProber()
		p.offline(keyA)
		l := newLoop(c, p)
		tickN(l, 3)
		if len(l.PausedRoutes()) != 1 {
			t.Fatal("want paused")
		}
	})
}

func TestCancelledRound_notCounted(t *testing.T) {
	c := testConfig()
	c.AutoPause.ICMPFallback = true
	c.AutoPause.FailuresToPause = 1
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	l.Tick(ctx)
	if got := l.PausedRoutes(); len(got) != 0 {
		t.Fatalf("shutdown counted as a peer failure: %v", got)
	}
}

func TestPeersTrackedIndependently(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes = append(c.Forwarding.Routes,
		config.ForwardRoute{Proto: "tcp", Ports: []string{"80"}, TargetIP: ipB, PauseWhenPeerOffline: true})
	p := newFakeProber()
	p.offline(keyA)
	p.online(keyB)
	l := newLoop(c, p)
	tickN(l, 3)
	got := l.PausedRoutes()
	if len(got) != 1 || got[0].Peer != "a" {
		t.Fatalf("paused = %v", got)
	}
}

func TestEventDetail_includesRouteName(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes[0].Name = "Minecraft"
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	var details []string
	l.Emit = func(r eventlog.Record) { details = append(details, r.Detail) }
	tickN(l, 3)
	want := "Minecraft: tcp 25565 -> 10.100.0.2 (peer a offline)"
	if len(details) != 1 || details[0] != want {
		t.Fatalf("details = %v, want %q", details, want)
	}
}

func TestRouteIndexShift_keepsPauseWithoutEvents(t *testing.T) {
	c := testConfig()
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	var events []string
	l.Emit = func(r eventlog.Record) { events = append(events, r.Event) }
	tickN(l, 3)

	// Adding a route ahead of the paused one must not read as a resume and re-pause.
	c.Forwarding.Routes = append([]config.ForwardRoute{{Proto: "tcp", Ports: []string{"80"}, TargetIP: ipB}}, c.Forwarding.Routes...)
	tickN(l, 2)
	if len(events) != 1 {
		t.Fatalf("events = %v", events)
	}
	if got := l.PausedRoutes(); len(got) != 1 || got[0].Ports[0] != "25565" {
		t.Fatalf("paused = %v", got)
	}
}

func TestRenameWhilePaused_updatesNamesWithoutEvents(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes[0].Name = "old"
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	var details []string
	l.Emit = func(r eventlog.Record) { details = append(details, r.Detail) }
	changes := 0
	l.OnChange = func([]PausedRoute) { changes++ }
	tickN(l, 3)

	c.Forwarding.Routes[0].Name = "new"
	c.Peers[0].Name = "renamed"
	tickN(l, 1)
	got := l.PausedRoutes()
	if len(got) != 1 || got[0].Name != "new" || got[0].Peer != "renamed" {
		t.Fatalf("paused = %+v, want the new names", got)
	}
	if len(details) != 1 || changes != 1 {
		t.Fatalf("rename reported as a change: details = %v, OnChange calls = %d", details, changes)
	}

	p.online(keyA)
	tickN(l, 2)
	want := "new: tcp 25565 -> 10.100.0.2 (peer renamed)"
	if len(details) != 2 || details[1] != want {
		t.Fatalf("details = %v, want resume %q", details, want)
	}
}

func TestPortReorderWhilePaused_noEvents(t *testing.T) {
	c := testConfig()
	c.Forwarding.Routes[0].Ports = []string{"80", "443"}
	p := newFakeProber()
	p.offline(keyA)
	l := newLoop(c, p)
	var events []string
	l.Emit = func(r eventlog.Record) { events = append(events, r.Event) }
	changes := 0
	l.OnChange = func([]PausedRoute) { changes++ }
	tickN(l, 3)

	c.Forwarding.Routes[0].Ports = []string{"443", "80"}
	tickN(l, 1)
	if len(events) != 1 || changes != 1 {
		t.Fatalf("reorder reported as a change: events = %v, OnChange calls = %d", events, changes)
	}
	// The key sorts a copy, so the ports keep their config order.
	got := l.PausedRoutes()
	if len(got) != 1 || got[0].Ports[0] != "443" || got[0].Ports[1] != "80" {
		t.Fatalf("paused = %+v, want ports in config order", got)
	}
	if ports := c.Forwarding.Routes[0].Ports; ports[0] != "443" || ports[1] != "80" {
		t.Fatalf("config ports changed: %v", ports)
	}
}
