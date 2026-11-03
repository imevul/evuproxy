package apply

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

// SyncPausedRoutes makes the live prerouting chain match the routes paused returns for the
// applied config, and does nothing if it already does. It changes that one chain, in one nft
// transaction, and leaves the rest of the firewall and WireGuard alone.
//
// It compares against the live chain rather than remembering what it did, because the chain
// can change under it: a full Apply from any process renders every route from config, and after
// a restart of `serve` a route may still be closed by the previous process. Calling it on every
// probe puts all of those right.
//
// paused is called with the lock held, so its indexes belong to the config used here. If the
// lock is busy nothing happens, and the next call tries again.
func SyncPausedRoutes(ctx context.Context, cfgPath string, paused func(*config.Config) []int) error {
	unlock, ok := tryApplyLock(cfgPath)
	if !ok {
		return nil
	}
	defer unlock()

	c := LoadAppliedConfig(cfgPath)
	if c == nil {
		return errors.New("no usable applied config")
	}
	update, err := gen.NATPreroutingUpdate(c, paused(c))
	if err != nil {
		return err
	}
	want := gen.PausedRoutesIn(update)
	live, err := runCmdOutput(ctx, "nft", "list", "chain", "ip", "evuproxy", "prerouting")
	if err != nil {
		// With no firewall loaded yet, an empty set has nothing to put right.
		if len(want) == 0 {
			return nil
		}
		return fmt.Errorf("read prerouting chain: %w", err)
	}
	if slices.Equal(want, gen.PausedRoutesIn(string(live))) {
		return nil
	}

	// The update relies on sets from the ruleset it is loaded over, and would replace that
	// ruleset's DNAT with this config's. A failed Apply can leave them apart.
	genDir := filepath.Join(filepath.Dir(cfgPath), GeneratedDir)
	full, err := gen.NFTables(c)
	if err != nil {
		return err
	}
	if loaded, err := os.ReadFile(filepath.Join(genDir, "nftables.nft")); err != nil || string(loaded) != full {
		return errors.New("the generated ruleset doesn't match the applied config; run an Apply")
	}

	path := filepath.Join(genDir, "paused-routes.nft")
	if err := writeAtomic(path, []byte(update), 0o644); err != nil {
		return fmt.Errorf("write paused routes: %w", err)
	}
	if out, err := runCmdCombined(ctx, "nft", "-c", "-f", path); err != nil {
		return fmt.Errorf("nft validate: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	if out, err := runCmdCombined(ctx, "nft", "-f", path); err != nil {
		return fmt.Errorf("nft load: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	return nil
}
