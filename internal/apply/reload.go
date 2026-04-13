package apply

import (
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

const (
	GeneratedDir = "generated"
)

// Reload writes generated artifacts and applies nftables + WireGuard.
func Reload(cfgPath string) error {
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
	wgPath := filepath.Join("/etc/wireguard", c.WireGuard.Interface+".conf")

	nftSrc, err := gen.NFTables(c)
	if err != nil {
		return err
	}
	if err := writeAtomic(nftPath, []byte(nftSrc), 0o644); err != nil {
		return fmt.Errorf("write nftables: %w", err)
	}

	wgSrc, err := gen.WireGuardConf(c)
	if err != nil {
		return fmt.Errorf("wireguard config: %w", err)
	}
	if err := writeAtomic(wgPath, []byte(wgSrc), 0o600); err != nil {
		return fmt.Errorf("write wireguard: %w", err)
	}

	check := exec.Command("nft", "-c", "-f", nftPath)
	if out, err := check.CombinedOutput(); err != nil {
		return fmt.Errorf("nft validate: %w\n%s", err, TruncateForLog(string(out), 8192))
	}

	// Replace EvuProxy tables atomically. Delete may fail if the table is absent; that is normal on first install.
	tryDeleteNFTTable("inet", "evuproxy")
	tryDeleteNFTTable("ip", "evuproxy")

	load := exec.Command("nft", "-f", nftPath)
	if out, err := load.CombinedOutput(); err != nil {
		return fmt.Errorf("nft load: %w\n%s", err, TruncateForLog(string(out), 8192))
	}

	if c.Geo.Enabled {
		if err := ensureGeoZones(c); err != nil {
			slog.Warn("geo zones", "err", err)
		}
		if err := applyGeoLoader(c, base); err != nil {
			slog.Warn("geo load failed; nft geo sets may be empty — run evuproxy update-geo", "err", err)
		}
	}

	if err := reloadWireGuard(c.WireGuard.Interface, wgPath); err != nil {
		return err
	}

	if err := RecordAppliedConfigHash(cfgPath); err != nil {
		return fmt.Errorf("record apply state: %w", err)
	}
	return nil
}

func ensureGeoZones(c *config.Config) error {
	for _, cc := range c.Geo.Countries {
		cc = strings.TrimSpace(strings.ToLower(cc))
		p := filepath.Join(c.Geo.ZoneDir, cc+".zone")
		if st, err := os.Stat(p); err != nil || st.Size() == 0 {
			return gen.DownloadZones(c)
		}
	}
	return nil
}

func applyGeoLoader(c *config.Config, configDir string) error {
	loaderPath := filepath.Join(configDir, GeneratedDir, "geo-loader.nft")
	s, err := gen.GeoLoaderNFT(c, c.Geo.ZoneDir)
	if err != nil {
		return err
	}
	if err := writeAtomic(loaderPath, []byte(s), 0o644); err != nil {
		return err
	}
	cmd := exec.Command("nft", "-c", "-f", loaderPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft validate geo: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	cmd = exec.Command("nft", "-f", loaderPath)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("nft load geo: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	return nil
}

func tryDeleteNFTTable(family, table string) {
	out, err := exec.Command("nft", "delete", "table", family, table).CombinedOutput()
	if err != nil {
		slog.Debug("nft delete table", "family", family, "table", table, "err", err, "output", TruncateForLog(string(out), 1024))
	}
}

func reloadWireGuard(iface, confPath string) error {
	if _, err := os.Stat("/sys/class/net/" + iface); err == nil {
		stripped, err := exec.Command("wg-quick", "strip", confPath).Output()
		if err != nil {
			return fmt.Errorf("wg-quick strip: %w", err)
		}
		f, err := os.CreateTemp("", "evuproxy-wg-*.conf")
		if err != nil {
			return err
		}
		tmp := f.Name()
		defer os.Remove(tmp)
		if _, err := f.Write(stripped); err != nil {
			f.Close()
			return err
		}
		if err := f.Close(); err != nil {
			return err
		}
		if out, err := exec.Command("wg", "syncconf", iface, tmp).CombinedOutput(); err != nil {
			return fmt.Errorf("wg syncconf: %w\n%s", err, out)
		}
		return nil
	}
	up := exec.Command("wg-quick", "up", confPath)
	if out, err := up.CombinedOutput(); err != nil {
		return fmt.Errorf("wg-quick up: %w\n%s", err, out)
	}
	return nil
}

func writeAtomic(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".evuproxy-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// UpdateGeo downloads zones and loads geo sets (nftables must already define the sets).
func UpdateGeo(cfgPath string) error {
	c, err := config.Load(cfgPath)
	if err != nil {
		return err
	}
	if !c.Geo.Enabled {
		return fmt.Errorf("geo is disabled in config")
	}
	if err := gen.DownloadZones(c); err != nil {
		return err
	}
	base := filepath.Dir(cfgPath)
	return applyGeoLoader(c, base)
}

// Status returns wg show and whether evuproxy tables exist.
func Status(cfgPath string) (string, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	wg := exec.Command("wg", "show", c.WireGuard.Interface)
	wgOut, err := wg.CombinedOutput()
	if err != nil {
		fmt.Fprintf(&b, "wireguard (%s): not running or missing: %v\n", c.WireGuard.Interface, err)
	} else {
		b.Write(wgOut)
	}
	ls := exec.Command("nft", "list", "table", "inet", "evuproxy")
	lsOut, err := ls.CombinedOutput()
	if err != nil {
		fmt.Fprintf(&b, "\nnftables inet evuproxy: %v\n", err)
	} else {
		b.WriteString("\n")
		b.Write(lsOut)
	}
	return b.String(), nil
}
