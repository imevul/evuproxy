package apply

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/imevul/evuproxy/internal/atomicio"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
	"github.com/imevul/evuproxy/internal/state"
)

const (
	GeneratedDir = "generated"
)

// wireguardConfigDir is where generated WireGuard configs are written.
// Package variable so unit tests can redirect writes away from /etc/wireguard.
var wireguardConfigDir = "/etc/wireguard"

// wgInterfaceExists reports whether the kernel interface is present. Package
// variable so unit tests can exercise both reloadWireGuard branches.
var wgInterfaceExists = func(iface string) bool {
	_, err := os.Stat("/sys/class/net/" + iface)
	return err == nil
}

// Reload writes generated artifacts and applies nftables + WireGuard.
// A cross-process file lock serializes it against other mutating operations
// (CLI vs API); privileged subprocesses run under per-command timeouts.
func Reload(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	err = reload(ctx, cfgPath)
	if err != nil {
		_ = state.RecordApplyFailure(cfgPath)
		return err
	}
	_ = state.RecordApplySuccess(cfgPath)
	return nil
}

func reload(ctx context.Context, cfgPath string) error {
	c, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	base := filepath.Dir(cfgPath)
	genDir := filepath.Join(base, GeneratedDir)
	if err := os.MkdirAll(genDir, 0o755); err != nil {
		return err
	}

	nftPath := filepath.Join(genDir, "nftables.nft")
	wgPath := filepath.Join(wireguardConfigDir, c.WireGuard.Interface+".conf")

	nftSrc, err := gen.NFTables(c)
	if err != nil {
		return err
	}
	if err := writeAtomic(nftPath, []byte(nftSrc), 0o644); err != nil {
		return fmt.Errorf("write nftables: %w", err)
	}

	// When geo is enabled, fold the geo set population into the same nft file as
	// the table replace so the whole apply is one kernel transaction: sets are
	// never live-but-empty (block mode would fail open, allow mode would drop
	// everything), and any zone/loader problem aborts before the kernel is touched.
	applySrc := nftSrc
	if c.Geo.Enabled {
		if err := ensureGeoZones(ctx, c); err != nil {
			return fmt.Errorf("geo zones: %w", err)
		}
		loaderSrc, err := gen.GeoLoaderNFT(c, c.Geo.ZoneDir)
		if err != nil {
			return fmt.Errorf("geo loader: %w", err)
		}
		if err := writeAtomic(filepath.Join(genDir, "geo-loader.nft"), []byte(loaderSrc), 0o644); err != nil {
			return fmt.Errorf("write geo loader: %w", err)
		}
		applySrc = nftSrc + "\n" + loaderSrc
	}
	applyPath := filepath.Join(genDir, "apply.nft")
	if err := writeAtomic(applyPath, []byte(applySrc), 0o644); err != nil {
		return fmt.Errorf("write nftables apply file: %w", err)
	}

	// Preserve any live CrowdSec bans across the atomic table replace: the generated
	// ruleset recreates crowdsec_block_v4 empty, so capture current elements first.
	// Skipped when the new config disables CrowdSec (the set no longer exists).
	var crowdsecSaved []crowdsecElem
	if c.CrowdSec.Enabled {
		crowdsecSaved = snapshotCrowdsecBlockSet(ctx)
	}

	if out, err := runCmdCombined(ctx, "nft", "-c", "-f", applyPath); err != nil {
		return fmt.Errorf("nft validate: %w\n%s", err, TruncateForLog(string(out), 8192))
	}

	// The apply file replaces the EvuProxy tables in a single nft transaction
	// (add+delete+define per table, plus geo set elements), so a failed load rolls
	// back atomically and the previous ruleset — including the INPUT policy-drop
	// chain — stays live.
	if out, err := runCmdCombined(ctx, "nft", "-f", applyPath); err != nil {
		return fmt.Errorf("nft load: %w\n%s", err, TruncateForLog(string(out), 8192))
	}

	if len(crowdsecSaved) > 0 {
		restoreCrowdsecBlockSet(ctx, crowdsecSaved)
	}

	if c.Geo.Enabled {
		if err := state.WriteGeoLastSuccess(cfgPath, "reload"); err != nil {
			slog.Warn("geo last-success metadata", "err", err)
		}
	}

	if err := reloadWireGuard(ctx, c.WireGuard.Interface, strings.TrimSpace(c.WireGuard.Address), wgPath); err != nil {
		return err
	}

	if err := state.RecordAppliedConfigHash(cfgPath); err != nil {
		return fmt.Errorf("record apply state: %w", err)
	}
	if err := state.RecordAppliedConfigSnapshot(cfgPath); err != nil {
		return fmt.Errorf("record config snapshot: %w", err)
	}
	if c.CrowdSec.Enabled {
		slog.Warn("crowdsec enabled: ensure CrowdSec nftables bouncer populates @crowdsec_block_v4 in table inet evuproxy (see contrib/crowdsec/)")
		tryRestartCrowdsecBouncer(cfgPath)
	}
	return nil
}

// ensureGeoZones downloads zone files when any required one (global countries
// plus every custom route's geo_countries) is missing or empty.
func ensureGeoZones(ctx context.Context, c *config.Config) error {
	for _, cc := range gen.GeoDownloadCountries(c) {
		p := filepath.Join(c.Geo.ZoneDir, cc+".zone")
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			return gen.DownloadZones(ctx, c)
		}
	}
	return nil
}

func applyGeoLoader(ctx context.Context, c *config.Config, configDir string) error {
	loaderPath := filepath.Join(configDir, GeneratedDir, "geo-loader.nft")
	s, err := gen.GeoLoaderNFT(c, c.Geo.ZoneDir)
	if err != nil {
		return err
	}
	if err := writeAtomic(loaderPath, []byte(s), 0o644); err != nil {
		return err
	}
	if out, err := runCmdCombined(ctx, "nft", "-c", "-f", loaderPath); err != nil {
		return fmt.Errorf("nft validate geo: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	if out, err := runCmdCombined(ctx, "nft", "-f", loaderPath); err != nil {
		return fmt.Errorf("nft load geo: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	return nil
}

func reloadWireGuard(ctx context.Context, iface, tunnelAddr, confPath string) error {
	if wgInterfaceExists(iface) {
		stripped, err := runCmdOutput(ctx, "wg-quick", "strip", confPath)
		if err != nil {
			return fmt.Errorf("wg-quick strip: %w", err)
		}
		// Temp file must live beside the WireGuard config: AppArmor profile "wg" on
		// Ubuntu/Debian allows /etc/wireguard/* but denies reads from /tmp.
		f, err := os.CreateTemp(filepath.Dir(confPath), ".evuproxy-wg-sync-*.conf")
		if err != nil {
			return err
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		if _, err := f.Write(stripped); err != nil {
			f.Close()
			return err
		}
		if err := f.Chmod(0o600); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		if out, err := runCmdCombined(ctx, "wg", "syncconf", iface, tmp); err != nil {
			return fmt.Errorf("wg syncconf: %w\n%s", err, out)
		}
		// wg syncconf does not apply Address=/routing from wg-quick; without a tunnel IP,
		// masquerade and some lookups behave oddly even when WireGuard installs peer /32 routes.
		if tunnelAddr != "" {
			if out, err := runCmdCombined(ctx, "ip", "-4", "addr", "replace", tunnelAddr, "dev", iface); err != nil {
				return fmt.Errorf("ip addr replace tunnel address on %s: %w\n%s", iface, err, out)
			}
		}
		return nil
	}
	if out, err := runCmdCombined(ctx, "wg-quick", "up", confPath); err != nil {
		return fmt.Errorf("wg-quick up: %w\n%s", err, out)
	}
	return nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	return atomicio.WriteFile(path, data, mode)
}

// UpdateGeo downloads zones and loads geo sets (nftables must already define the sets).
func UpdateGeo(ctx context.Context, cfgPath string) error {
	unlock, err := acquireApplyLock(ctx, cfgPath)
	if err != nil {
		return err
	}
	defer unlock()
	err = updateGeo(ctx, cfgPath)
	if err != nil {
		_ = state.RecordApplyFailure(cfgPath)
		return err
	}
	_ = state.RecordApplySuccess(cfgPath)
	return nil
}

func updateGeo(ctx context.Context, cfgPath string) error {
	c, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	if !c.Geo.Enabled {
		return fmt.Errorf("geo is disabled in config")
	}
	if err := gen.DownloadZones(ctx, c); err != nil {
		return err
	}
	base := filepath.Dir(cfgPath)
	if err := applyGeoLoader(ctx, c, base); err != nil {
		return err
	}
	if err := state.WriteGeoLastSuccess(cfgPath, "update-geo"); err != nil {
		slog.Warn("geo last-success metadata", "err", err)
	}
	return nil
}

// Status returns wg show and whether evuproxy tables exist.
func Status(ctx context.Context, cfgPath string) (string, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	wgOut, err := runCmdCombined(ctx, "wg", "show", c.WireGuard.Interface)
	if err != nil {
		fmt.Fprintf(&b, "wireguard (%s): not running or missing: %v\n", c.WireGuard.Interface, err)
	} else {
		b.Write(wgOut)
	}
	lsOut, err := runCmdCombined(ctx, "nft", "list", "table", "inet", "evuproxy")
	if err != nil {
		fmt.Fprintf(&b, "\nnftables inet evuproxy: %v\n", err)
	} else {
		b.WriteString("\n")
		b.Write(lsOut)
	}
	return b.String(), nil
}
