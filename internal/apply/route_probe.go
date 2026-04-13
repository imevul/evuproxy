package apply

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/imevul/evuproxy/internal/config"
)

// RouteProbeResult is returned from ProbeForwardingRoute.
type RouteProbeResult struct {
	Proto       string `json:"proto"`
	Port        int    `json:"port"`
	TargetIP    string `json:"target_ip"`
	Status      string `json:"status"` // ok, refused, inconclusive, error
	LatencyMS   int64  `json:"latency_ms,omitempty"`
	ErrorDetail string `json:"error_detail,omitempty"`
}

// ProbeForwardingRoute dials target_ip:port using protocols from the route (TCP always tried for tcp/both; UDP for udp/both).
func ProbeForwardingRoute(ctx context.Context, c *config.Config, routeIndex, portOverride int) ([]RouteProbeResult, error) {
	if routeIndex < 0 || routeIndex >= len(c.Forwarding.Routes) {
		return nil, fmt.Errorf("invalid route_index")
	}
	r := c.Forwarding.Routes[routeIndex]
	if r.Disabled {
		return nil, fmt.Errorf("route is disabled")
	}
	protos, err := config.ParseRouteProtocols(r.Proto)
	if err != nil {
		return nil, err
	}
	ports, err := config.ExpandRoutePortNumbers(r.Ports)
	if err != nil {
		return nil, err
	}
	if len(ports) == 0 {
		return nil, fmt.Errorf("route has no ports")
	}
	port := int(ports[0])
	if portOverride > 0 {
		found := false
		for _, p := range ports {
			if int(p) == portOverride {
				found = true
				port = portOverride
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("port not in route")
		}
	}
	ip := strings.TrimSpace(r.TargetIP)
	if net.ParseIP(ip) == nil {
		return nil, fmt.Errorf("invalid target_ip")
	}

	var out []RouteProbeResult
	d := net.Dialer{Timeout: 3 * time.Second}
	for _, proto := range protos {
		res := RouteProbeResult{Proto: proto, Port: port, TargetIP: ip}
		addr := net.JoinHostPort(ip, strconv.Itoa(port))
		switch proto {
		case "tcp":
			start := time.Now()
			conn, err := d.DialContext(ctx, "tcp", addr)
			res.LatencyMS = time.Since(start).Milliseconds()
			if err != nil {
				if isRefused(err) {
					res.Status = "refused"
				} else {
					res.Status = "error"
				}
				res.ErrorDetail = err.Error()
			} else {
				_ = conn.Close()
				res.Status = "ok"
			}
		case "udp":
			start := time.Now()
			conn, err := d.DialContext(ctx, "udp", addr)
			res.LatencyMS = time.Since(start).Milliseconds()
			if err != nil {
				res.Status = "error"
				res.ErrorDetail = err.Error()
			} else {
				_, _ = conn.Write([]byte{0})
				_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
				buf := make([]byte, 1)
				_, rerr := conn.Read(buf)
				_ = conn.Close()
				if rerr == nil {
					res.Status = "ok"
				} else {
					res.Status = "inconclusive"
					res.ErrorDetail = "no response within deadline (UDP may still work)"
				}
			}
		}
		out = append(out, res)
	}
	return out, nil
}

func isRefused(err error) bool {
	if err == nil {
		return false
	}
	var op *net.OpError
	if errors.As(err, &op) {
		if errno, ok := op.Err.(syscall.Errno); ok && errno == syscall.ECONNREFUSED {
			return true
		}
	}
	var errno syscall.Errno
	if errors.As(err, &errno) && errno == syscall.ECONNREFUSED {
		return true
	}
	s := err.Error()
	return strings.Contains(s, "refused") || strings.Contains(s, "REFUSED")
}
