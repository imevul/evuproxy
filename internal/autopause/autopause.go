// Package autopause tracks the peers targeted by routes with pause_when_peer_offline and
// derives which routes are paused. State is runtime-only: it never touches config, and after
// a restart every route starts as not paused.
package autopause

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/observability"
)

// Prober reads the signals that decide whether a peer is online.
type Prober interface {
	// Handshakes returns the latest handshake (Unix seconds) by peer public key.
	Handshakes(iface string) (map[string]int64, error)
	// Ping returns nil when the tunnel IPv4 replies.
	Ping(ctx context.Context, ip string) error
}

// HostProber reads WireGuard state and sends ICMP on this host.
type HostProber struct{}

// Handshakes implements Prober using `wg show IFACE dump`.
func (HostProber) Handshakes(iface string) (map[string]int64, error) {
	peers, err := apply.WireGuardPeers(iface)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int64, len(peers))
	for _, p := range peers {
		out[p.PublicKey] = p.LatestHandshake
	}
	return out, nil
}

// Ping implements Prober using the ping binary.
func (HostProber) Ping(ctx context.Context, ip string) error {
	return apply.PingTunnelIP(ctx, ip)
}

// LoadConfig returns the last applied config, so pending edits have no effect until Apply.
// With no usable applied snapshot it uses config.yaml, as geo updates do.
func LoadConfig(cfgPath string) (*config.Config, error) {
	if c := apply.LoadAppliedConfig(cfgPath); c != nil {
		return c, nil
	}
	return config.Load(cfgPath)
}

// PausedRoute is one route currently paused because its target peer is offline.
type PausedRoute struct {
	Name     string   `json:"name,omitempty"`
	Proto    string   `json:"proto"`
	Ports    []string `json:"ports"`
	TargetIP string   `json:"target_ip"`
	Peer     string   `json:"peer"`
}

// key identifies the route across ticks. Names and port order are left out, so editing them
// while paused isn't a change to the paused set.
func (r PausedRoute) key() string {
	ports := slices.Sorted(slices.Values(r.Ports))
	return strings.ToLower(r.Proto) + "\x00" + strings.Join(ports, ",") + "\x00" + r.TargetIP
}

func (r PausedRoute) String() string {
	s := fmt.Sprintf("%s %s -> %s", r.Proto, strings.Join(r.Ports, ","), r.TargetIP)
	if r.Name != "" {
		return r.Name + ": " + s
	}
	return s
}

// hysteresis counts consecutive probe results for one peer.
type hysteresis struct {
	paused    bool
	failures  int
	successes int
}

// observe records one probe result. A result of the other kind resets the count, so only
// an unbroken run of failures pauses and an unbroken run of successes resumes.
func (h *hysteresis) observe(online bool, failuresToPause, successesToResume int) {
	if online {
		h.failures = 0
		h.successes++
		if h.paused && h.successes >= successesToResume {
			h.paused = false
		}
		return
	}
	h.successes = 0
	h.failures++
	if !h.paused && h.failures >= failuresToPause {
		h.paused = true
	}
}

// Loop probes peers on an interval and maintains the paused route set.
type Loop struct {
	// Load returns the config to act on. It is called on every tick, so changes apply without a restart.
	Load   func() (*config.Config, error)
	Prober Prober
	Logger *slog.Logger
	// Emit optionally records pause and resume events.
	Emit func(eventlog.Record)
	// OnChange is optionally called with the new paused set whenever it changes.
	OnChange func([]PausedRoute)
	// Now and wait are replaced in tests.
	Now  func() time.Time
	wait func(context.Context, time.Duration) bool

	peers map[string]*hysteresis // by peer public key; only peers being watched

	mu     sync.RWMutex
	paused []PausedRoute
}

// PausedRoutes returns the routes paused as of the last tick.
func (l *Loop) PausedRoutes() []PausedRoute {
	l.mu.RLock()
	defer l.mu.RUnlock()
	return append([]PausedRoute(nil), l.paused...)
}

// Run ticks until ctx is cancelled. The first probe runs one interval after start, so a
// freshly restarted host gets a full pause delay to re-establish handshakes.
func (l *Loop) Run(ctx context.Context) {
	wait := l.wait
	if wait == nil {
		wait = waitFor
	}
	interval := config.DefaultAutoPauseInterval
	if c, err := l.Load(); err == nil {
		interval = c.AutoPause.EffectiveInterval()
	}
	for wait(ctx, interval) {
		if next := l.Tick(ctx); next > 0 {
			interval = next
		}
	}
}

func waitFor(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Tick runs one probe round and returns the configured interval, or 0 if config could not be read.
func (l *Loop) Tick(ctx context.Context) time.Duration {
	c, err := l.Load()
	if err != nil {
		// Without config there is nothing to decide on, so state is kept as it is.
		l.logger().Error("auto-pause: load config", "err", err)
		return 0
	}
	watched := watchedPeers(c)
	for key := range l.peers {
		if _, ok := watched[key]; !ok {
			delete(l.peers, key)
		}
	}
	if len(watched) > 0 {
		l.probe(ctx, c, watched)
	}
	if ctx.Err() != nil {
		return 0
	}
	l.publish(l.derivePaused(c))
	return c.AutoPause.EffectiveInterval()
}

// probe feeds one result per watched peer into its hysteresis. When handshakes can't be read
// at all the round says nothing about the peers, so it isn't counted either way.
func (l *Loop) probe(ctx context.Context, c *config.Config, watched map[string]config.Peer) {
	hs, err := l.Prober.Handshakes(c.WireGuard.Interface)
	if err != nil {
		l.logger().Warn("auto-pause: read handshakes", "err", err)
		return
	}
	now := time.Now
	if l.Now != nil {
		now = l.Now
	}
	online := l.signals(ctx, c, watched, hs, now().Unix())
	if ctx.Err() != nil {
		return
	}
	if l.peers == nil {
		l.peers = map[string]*hysteresis{}
	}
	failures := c.AutoPause.EffectiveFailuresToPause()
	successes := c.AutoPause.EffectiveSuccessesToResume()
	for key := range watched {
		h := l.peers[key]
		if h == nil {
			h = &hysteresis{}
			l.peers[key] = h
		}
		h.observe(online[key], failures, successes)
	}
}

// signals decides online or offline per peer. One signal decides: a fresh handshake is online
// with no ping, and only a stale or missing handshake consults ICMP, when that is enabled.
func (l *Loop) signals(ctx context.Context, c *config.Config, watched map[string]config.Peer, hs map[string]int64, nowUnix int64) map[string]bool {
	const maxConcurrentPings = 8
	sem := make(chan struct{}, maxConcurrentPings)
	var wg sync.WaitGroup
	var mu sync.Mutex
	online := make(map[string]bool, len(watched))
	for key, p := range watched {
		last := hs[key]
		if last > 0 && nowUnix-last <= observability.PeerOnlineMaxHandshakeAgeSec {
			online[key] = true
			continue
		}
		if !c.AutoPause.ICMPFallback {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				return
			}
			if err := l.Prober.Ping(ctx, config.PeerTunnelIPv4(p.TunnelIP)); err == nil {
				mu.Lock()
				online[key] = true
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return online
}

// watchedPeers returns the peers targeted by at least one active route with the setting on,
// by public key. Peers with no such route are never probed.
func watchedPeers(c *config.Config) map[string]config.Peer {
	out := map[string]config.Peer{}
	for _, r := range c.Forwarding.Routes {
		if !r.PauseWhenPeerOffline || r.Disabled {
			continue
		}
		if p, ok := peerForRoute(c, r); ok {
			out[p.PublicKey] = p
		}
	}
	return out
}

func peerForRoute(c *config.Config, r config.ForwardRoute) (config.Peer, bool) {
	target := strings.TrimSpace(r.TargetIP)
	for _, p := range c.Peers {
		if !p.Disabled && config.PeerTunnelIPv4(p.TunnelIP) == target {
			return p, true
		}
	}
	return config.Peer{}, false
}

// derivePaused maps peer state onto routes. Disabled routes are never included: they stay the
// user's setting, and the loop neither pauses nor resumes them.
func (l *Loop) derivePaused(c *config.Config) []PausedRoute {
	var out []PausedRoute
	for _, r := range c.Forwarding.Routes {
		if !r.PauseWhenPeerOffline || r.Disabled {
			continue
		}
		p, ok := peerForRoute(c, r)
		if !ok {
			continue
		}
		if h := l.peers[p.PublicKey]; h != nil && h.paused {
			out = append(out, PausedRoute{
				Name:     r.Name,
				Proto:    r.Proto,
				Ports:    append([]string(nil), r.Ports...),
				TargetIP: strings.TrimSpace(r.TargetIP),
				Peer:     p.Name,
			})
		}
	}
	return out
}

// publish stores the new paused set and reports what changed.
func (l *Loop) publish(next []PausedRoute) {
	l.mu.RLock()
	prev := l.paused
	l.mu.RUnlock()

	prevKeys := make(map[string]struct{}, len(prev))
	for _, r := range prev {
		prevKeys[r.key()] = struct{}{}
	}
	nextKeys := make(map[string]struct{}, len(next))
	changed := false
	for _, r := range next {
		nextKeys[r.key()] = struct{}{}
		if _, ok := prevKeys[r.key()]; !ok {
			changed = true
			l.logger().Warn("auto-pause: route paused, peer offline", "route", r.String(), "peer", r.Peer)
			l.emit(eventlog.Record{Event: "route_auto_paused", Detail: fmt.Sprintf("%s (peer %s offline)", r, r.Peer)})
		}
	}
	for _, r := range prev {
		if _, ok := nextKeys[r.key()]; !ok {
			changed = true
			l.logger().Info("auto-pause: route resumed", "route", r.String(), "peer", r.Peer)
			l.emit(eventlog.Record{Event: "route_auto_resumed", Detail: fmt.Sprintf("%s (peer %s)", r, r.Peer)})
		}
	}
	// Stored even when the set is the same, so PausedRoutes has current names and port order.
	l.mu.Lock()
	l.paused = next
	l.mu.Unlock()
	if changed && l.OnChange != nil {
		l.OnChange(append([]PausedRoute(nil), next...))
	}
}

func (l *Loop) emit(rec eventlog.Record) {
	if l.Emit != nil {
		l.Emit(rec)
	}
}

func (l *Loop) logger() *slog.Logger {
	if l.Logger != nil {
		return l.Logger
	}
	return slog.Default()
}
