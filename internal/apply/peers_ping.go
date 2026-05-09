package apply

import (
	"context"
	"fmt"
	"math"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/imevul/evuproxy/internal/config"
)

var pingTimeMsRE = regexp.MustCompile(`time[=<]([0-9]+(?:\.[0-9]+)?)\s*ms`)

// PeerPingResult is one ICMP measurement for an enabled peer (WireGuard tunnel IPv4).
type PeerPingResult struct {
	Name      string `json:"name"`
	TunnelIP  string `json:"tunnel_ip"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
	OK        bool   `json:"ok"`
	Error     string `json:"error,omitempty"`
}

// PeersPing runs ping once per non-disabled peer tunnel IPv4. Requires a `ping` binary (e.g. iputils).
// Pings run with limited parallelism to avoid long serial timeouts when many peers exist.
func PeersPing(ctx context.Context, cfgPath string) ([]PeerPingResult, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return nil, err
	}
	pingBin, lookErr := exec.LookPath("ping")

	type job struct {
		peer config.Peer
	}
	var jobs []job
	for _, p := range c.Peers {
		if p.Disabled {
			continue
		}
		jobs = append(jobs, job{p})
	}
	if len(jobs) == 0 {
		return nil, nil
	}

	const maxConcurrent = 8
	sem := make(chan struct{}, maxConcurrent)
	out := make([]PeerPingResult, len(jobs))
	var wg sync.WaitGroup
	for k := range jobs {
		k := k
		wg.Add(1)
		go func() {
			defer wg.Done()
			p := jobs[k].peer
			ip := config.PeerTunnelIPv4(p.TunnelIP)
			r := PeerPingResult{Name: p.Name, TunnelIP: ip}
			defer func() { out[k] = r }()

			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				r.Error = ctx.Err().Error()
				return
			}
			if ip == "" {
				r.Error = "invalid tunnel_ip"
				return
			}
			if lookErr != nil || pingBin == "" {
				r.Error = "ping executable not found in PATH"
				return
			}
			ms, perr := pingOnce(ctx, pingBin, ip)
			if perr != nil {
				r.Error = perr.Error()
			} else {
				r.OK = true
				r.LatencyMS = ms
			}
		}()
	}
	wg.Wait()
	return out, nil
}

func pingOnce(ctx context.Context, pingBin, ip string) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, pingBin, "-c", "1", "-W", "2", ip)
	cmdOut, err := cmd.CombinedOutput()
	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return 0, fmt.Errorf("timeout")
		}
		s := strings.TrimSpace(string(cmdOut))
		if s != "" {
			return 0, fmt.Errorf("%w: %s", err, s)
		}
		return 0, err
	}
	s := string(cmdOut)
	m := pingTimeMsRE.FindStringSubmatch(s)
	if len(m) < 2 {
		return 0, fmt.Errorf("could not parse ping output")
	}
	f, err := strconv.ParseFloat(m[1], 64)
	if err != nil {
		return 0, err
	}
	return int64(math.Round(f)), nil
}
