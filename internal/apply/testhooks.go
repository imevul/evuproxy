package apply

import (
	"context"
	"net"
)

// CommandRunner mirrors the internal subprocess seam so tests in other
// packages (e.g. internal/api) can stub privileged command execution.
type CommandRunner interface {
	CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error)
	Output(ctx context.Context, name string, args ...string) ([]byte, error)
	OutputWithStdin(ctx context.Context, stdin, name string, args ...string) ([]byte, error)
}

// SwapCommandRunnerForTest replaces the process-wide command runner and
// returns a restore func. Test use only; not safe under parallel swaps.
func SwapCommandRunnerForTest(r CommandRunner) (restore func()) {
	prev := runner
	runner = r
	return func() { runner = prev }
}

// SwapWireGuardConfigDirForTest redirects generated WireGuard config writes
// away from /etc/wireguard. Test use only.
func SwapWireGuardConfigDirForTest(dir string) (restore func()) {
	prev := wireguardConfigDir
	wireguardConfigDir = dir
	return func() { wireguardConfigDir = prev }
}

// SwapSystemdNetworkDirForTest redirects Unmanaged=yes drop-in writes. Test use only.
func SwapSystemdNetworkDirForTest(dir string) (restore func()) {
	prev := systemdNetworkDir
	systemdNetworkDir = dir
	return func() { systemdNetworkDir = prev }
}

// SwapNetworkdOrNetplanInUseForTest forces networkd/netplan detection. Test use only.
func SwapNetworkdOrNetplanInUseForTest(fn func() bool) (restore func()) {
	prev := networkdOrNetplanInUse
	networkdOrNetplanInUse = fn
	return func() { networkdOrNetplanInUse = prev }
}

// SwapWgInterfaceExistsForTest stubs kernel iface presence. Test use only.
func SwapWgInterfaceExistsForTest(fn func(string) bool) (restore func()) {
	prev := wgInterfaceExists
	wgInterfaceExists = fn
	return func() { wgInterfaceExists = prev }
}

// SwapLookupIPForTest stubs DNS resolution for endpoint warnings. Test use only.
func SwapLookupIPForTest(fn func(host string) ([]net.IP, error)) (restore func()) {
	prev := lookupIPFn
	lookupIPFn = fn
	return func() { lookupIPFn = prev }
}

// SwapHostPublicAddrsForTest stubs host public address discovery. Test use only.
func SwapHostPublicAddrsForTest(fn func(ctx context.Context, pubIF string) ([]net.IP, error)) (restore func()) {
	prev := hostPublicAddrsFn
	hostPublicAddrsFn = fn
	return func() { hostPublicAddrsFn = prev }
}
