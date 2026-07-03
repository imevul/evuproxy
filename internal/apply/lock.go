package apply

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"
)

// applyLockName is the advisory lock file in the config directory. It serializes
// mutating operations (reload, update-geo, backup, restore, config save, discard)
// across processes — e.g. an interactive `evuproxy reload` running while the API
// service handles a concurrent reload — so nft/wg apply steps and the
// read-modify-write state files (.evuproxy-last-applied.json, apply-metrics.json,
// .bak rotation) cannot interleave and corrupt each other.
const applyLockName = ".evuproxy.lock"

// applyLockWait caps how long we wait for a contended lock before giving up, so a
// wedged lock holder cannot block API handlers (which also hold the in-process
// mutex) indefinitely.
const applyLockWait = 2 * time.Minute

const applyLockPollInterval = 100 * time.Millisecond

// acquireApplyLock takes an exclusive flock keyed on the config directory. It
// polls non-blocking so it can honor ctx cancellation and the applyLockWait cap
// instead of wedging in an uninterruptible flock(2). The returned function
// releases the lock and closes the file; callers must defer it.
func acquireApplyLock(ctx context.Context, cfgPath string) (func(), error) {
	if ctx == nil {
		ctx = context.Background()
	}
	dir := filepath.Dir(cfgPath)
	lockPath := filepath.Join(dir, applyLockName)
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("acquire apply lock: %w", err)
	}
	deadline := time.Now().Add(applyLockWait)
	for {
		err := unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EINTR) {
			f.Close()
			return nil, fmt.Errorf("acquire apply lock: %w", err)
		}
		if time.Now().After(deadline) {
			f.Close()
			return nil, fmt.Errorf("acquire apply lock: another evuproxy operation holds %s", lockPath)
		}
		select {
		case <-ctx.Done():
			f.Close()
			return nil, fmt.Errorf("acquire apply lock: %w", ctx.Err())
		case <-time.After(applyLockPollInterval):
		}
	}
	return func() {
		_ = unix.Flock(int(f.Fd()), unix.LOCK_UN)
		_ = f.Close()
	}, nil
}
