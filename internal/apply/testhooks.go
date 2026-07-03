package apply

import "context"

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
