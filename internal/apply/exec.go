package apply

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// defaultCmdTimeout bounds any single privileged subprocess (nft, wg, wg-quick,
// tar, ip). Without it a hung command — e.g. a stalled netlink call — would block
// the caller indefinitely while it holds the API apply mutex, wedging every
// mutating endpoint into permanent 503s until the process is restarted.
const defaultCmdTimeout = 60 * time.Second

// cmdRunner abstracts subprocess execution so the reload pipeline can be unit
// tested with a fake; osRunner is the production implementation.
type cmdRunner interface {
	// CombinedOutput runs the command and returns interleaved stdout+stderr.
	CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error)
	// Output runs the command and returns stdout only.
	Output(ctx context.Context, name string, args ...string) ([]byte, error)
	// OutputWithStdin runs the command with stdin content and returns stdout only.
	OutputWithStdin(ctx context.Context, stdin, name string, args ...string) ([]byte, error)
}

// runner is the process-wide command runner; tests swap it for a fake.
var runner cmdRunner = osRunner{}

type osRunner struct{}

func (osRunner) CombinedOutput(parent context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := cmdContext(parent)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func (osRunner) Output(parent context.Context, name string, args ...string) ([]byte, error) {
	ctx, cancel := cmdContext(parent)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).Output()
}

func (osRunner) OutputWithStdin(parent context.Context, stdin, name string, args ...string) ([]byte, error) {
	ctx, cancel := cmdContext(parent)
	defer cancel()
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = strings.NewReader(stdin)
	return cmd.Output()
}

// cmdContext derives a per-command context bounded by defaultCmdTimeout (and by
// parent's deadline, whichever is sooner). Callers MUST defer the returned cancel.
func cmdContext(parent context.Context) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, defaultCmdTimeout)
}

// runCmdCombined runs name+args with a per-command timeout and returns combined
// output. It is the standard way to invoke privileged tools in the apply layer.
func runCmdCombined(parent context.Context, name string, args ...string) ([]byte, error) {
	return runner.CombinedOutput(parent, name, args...)
}

// runCmdOutput runs name+args with a per-command timeout and returns stdout only.
func runCmdOutput(parent context.Context, name string, args ...string) ([]byte, error) {
	return runner.Output(parent, name, args...)
}

// runCmdOutputStdin runs name+args feeding stdin, with a per-command timeout.
func runCmdOutputStdin(parent context.Context, stdin, name string, args ...string) ([]byte, error) {
	return runner.OutputWithStdin(parent, stdin, name, args...)
}
