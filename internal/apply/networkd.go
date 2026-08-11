package apply

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// systemdNetworkDir is where .network drop-ins are written. Overridable in tests.
var systemdNetworkDir = "/etc/systemd/network"

// networkdOrNetplanInUse reports whether systemd-networkd and/or netplan appear
// to manage host networking. Package variable so tests can force true/false.
var networkdOrNetplanInUse = detectNetworkdOrNetplanInUse

func detectNetworkdOrNetplanInUse() bool {
	for _, pattern := range []string{"/etc/netplan/*.yaml", "/etc/netplan/*.yml"} {
		matches, _ := filepath.Glob(pattern)
		if len(matches) > 0 {
			return true
		}
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return false
	}
	ctx := context.Background()
	if out, err := runCmdCombined(ctx, "systemctl", "is-enabled", "systemd-networkd"); err == nil {
		s := strings.TrimSpace(string(out))
		if s == "enabled" || s == "static" || s == "indirect" || s == "enabled-runtime" {
			return true
		}
	}
	if out, err := runCmdCombined(ctx, "systemctl", "is-active", "systemd-networkd"); err == nil {
		if strings.TrimSpace(string(out)) == "active" {
			return true
		}
	}
	return false
}

// WireGuardUnmanagedNetworkPath is the systemd-networkd unit path for iface.
// The "00-" prefix sorts before netplan's typical "10-netplan-*.network" so
// Unmanaged=yes wins (networkd applies the first matching .network file).
func WireGuardUnmanagedNetworkPath(iface string) string {
	iface = strings.TrimSpace(iface)
	if iface == "" {
		iface = "evuproxy0"
	}
	return filepath.Join(systemdNetworkDir, "00-"+iface+".network")
}

func wireGuardUnmanagedLegacyPaths(iface string) []string {
	iface = strings.TrimSpace(iface)
	if iface == "" {
		return nil
	}
	// Older installs used 80-, which loses to 10-netplan-* lexicographically.
	return []string{filepath.Join(systemdNetworkDir, "80-"+iface+".network")}
}

func wireGuardUnmanagedNetworkBody(iface string) string {
	return fmt.Sprintf("[Match]\nName=%s\n\n[Link]\nUnmanaged=yes\n", iface)
}

// EnsureWireGuardUnmanaged writes a systemd-networkd drop-in that marks the
// WireGuard iface Unmanaged, but only when networkd/netplan appears in use.
// When skipped, path is empty and installed is false.
func EnsureWireGuardUnmanaged(iface string) (path string, installed bool, err error) {
	iface = strings.TrimSpace(iface)
	if iface == "" {
		return "", false, fmt.Errorf("wireguard interface name is empty")
	}
	if !networkdOrNetplanInUse() {
		return "", false, nil
	}
	if err := os.MkdirAll(systemdNetworkDir, 0o755); err != nil {
		return "", false, err
	}
	path = WireGuardUnmanagedNetworkPath(iface)
	body := wireGuardUnmanagedNetworkBody(iface)
	legacyRemoved := false
	for _, legacy := range wireGuardUnmanagedLegacyPaths(iface) {
		if legacy == path {
			continue
		}
		if err := os.Remove(legacy); err == nil {
			legacyRemoved = true
			slog.Info("removed legacy systemd-networkd drop-in", "path", legacy)
		} else if !os.IsNotExist(err) {
			slog.Warn("could not remove legacy systemd-networkd drop-in", "path", legacy, "err", err)
		}
	}
	if prev, err := os.ReadFile(path); err == nil && string(prev) == body {
		return path, legacyRemoved, nil
	}
	if err := writeAtomic(path, []byte(body), 0o644); err != nil {
		return path, false, err
	}
	return path, true, nil
}

// EnsureWireGuardUnmanagedFromConfig loads config and ensures the drop-in.
// When networkd/netplan is in use, prints a line with the path (for install/update).
// Silent no-op when neither is in use.
func EnsureWireGuardUnmanagedFromConfig(cfgPath string) error {
	c, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	path, wrote, err := EnsureWireGuardUnmanaged(c.WireGuard.Interface)
	if err != nil {
		return err
	}
	if path == "" {
		return nil
	}
	if wrote {
		slog.Info("systemd-networkd unmanaged drop-in installed", "path", path, "iface", c.WireGuard.Interface)
		fmt.Fprintf(os.Stdout, "evuproxy: installed systemd-networkd unmanaged drop-in: %s\n", path)
	} else {
		slog.Info("systemd-networkd unmanaged drop-in present", "path", path, "iface", c.WireGuard.Interface)
		fmt.Fprintf(os.Stdout, "evuproxy: systemd-networkd unmanaged drop-in already present: %s\n", path)
	}
	return nil
}

// ensureWireGuardUnmanagedQuiet is for reload: slog only, no stdout.
func ensureWireGuardUnmanagedQuiet(iface string) {
	path, wrote, err := EnsureWireGuardUnmanaged(iface)
	if err != nil {
		slog.Warn("systemd-networkd unmanaged drop-in", "err", err, "iface", iface)
		return
	}
	if path == "" {
		return
	}
	if wrote {
		slog.Info("systemd-networkd unmanaged drop-in installed", "path", path, "iface", iface)
	} else {
		slog.Info("systemd-networkd unmanaged drop-in present", "path", path, "iface", iface)
	}
}

// WireGuardHostWarning is a host-side WireGuard health warning for status/overview.
type WireGuardHostWarning struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// WireGuardHostWarnings returns warnings about tunnel address presence and
// iface names that are likely to match broad netplan "e*" patterns.
func WireGuardHostWarnings(ctx context.Context, c *config.Config) []WireGuardHostWarning {
	if c == nil {
		return nil
	}
	iface := strings.TrimSpace(c.WireGuard.Interface)
	addr := strings.TrimSpace(c.WireGuard.Address)
	var out []WireGuardHostWarning
	if iface != "" && strings.HasPrefix(strings.ToLower(iface), "e") && networkdOrNetplanInUse() {
		dropIn := WireGuardUnmanagedNetworkPath(iface)
		if _, err := os.Stat(dropIn); err != nil {
			out = append(out, WireGuardHostWarning{
				Code: "wg_iface_netplan_e_prefix_risk",
				Message: "WireGuard interface " + iface + " starts with \"e\" and may match netplan " +
					"patterns like name: \"e*\" (systemd-networkd can wipe the tunnel address). " +
					"Narrow netplan to the real NIC, or run: evuproxy ensure-wg-networkd. " +
					"See docs/config.md (WireGuard and systemd-networkd).",
			})
		}
	}
	if iface == "" || addr == "" {
		return out
	}
	if !wgInterfaceExists(iface) {
		return out
	}
	ok, err := wireGuardTunnelAddrPresent(ctx, iface, addr)
	if err != nil {
		out = append(out, WireGuardHostWarning{
			Code:    "wg_tunnel_address_check_failed",
			Message: "Could not verify tunnel address on " + iface + ": " + err.Error(),
		})
		return out
	}
	if !ok {
		out = append(out, WireGuardHostWarning{
			Code: "wg_tunnel_address_missing",
			Message: "WireGuard interface " + iface + " is up but missing configured address " + addr +
				". Forwards will fail with OUT=eth0 / evuproxy-forward-drop. Restore with: " +
				"ip -4 addr replace " + addr + " dev " + iface + "  (or: evuproxy reload). " +
				"Often caused by systemd-networkd/netplan matching the iface — see docs/config.md.",
		})
	}
	return out
}

func wireGuardTunnelAddrPresent(ctx context.Context, iface, addrCIDR string) (bool, error) {
	wantIP := addrCIDR
	if i := strings.IndexByte(addrCIDR, '/'); i >= 0 {
		wantIP = addrCIDR[:i]
	}
	wantIP = strings.TrimSpace(wantIP)
	if wantIP == "" {
		return false, fmt.Errorf("empty address")
	}
	out, err := runCmdCombined(ctx, "ip", "-4", "-o", "addr", "show", "dev", iface)
	if err != nil {
		// Device missing is handled by caller via wgInterfaceExists; treat as absent.
		if strings.Contains(string(out), "does not exist") || strings.Contains(err.Error(), "does not exist") {
			return false, nil
		}
		return false, fmt.Errorf("%w: %s", err, TruncateForLog(string(out), 512))
	}
	// ip -o lines look like: 3: evuproxy0    inet 10.100.0.1/24 scope global ...
	for _, field := range strings.Fields(string(out)) {
		if field == wantIP || strings.HasPrefix(field, wantIP+"/") {
			return true, nil
		}
	}
	return false, nil
}
