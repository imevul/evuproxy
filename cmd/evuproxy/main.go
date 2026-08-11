package main

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/oschwald/geoip2-golang"
	"github.com/spf13/cobra"

	"github.com/imevul/evuproxy/internal/api"
	"github.com/imevul/evuproxy/internal/apply"
	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/logging"
	"github.com/imevul/evuproxy/internal/observability"
)

var (
	// x-release-please-start-version
	version = "0.15.1"
	// x-release-please-end
	cfgPath string
)

func main() {
	root := &cobra.Command{
		Use:   "evuproxy",
		Short: "EvuProxy — WireGuard + nftables forwarding control",
	}
	root.PersistentFlags().StringVar(&cfgPath, "config", "/etc/evuproxy/config.yaml", "path to evuproxy config")

	root.AddCommand(
		cmdMetrics(),
		cmdVersion(),
		cmdReload(),
		cmdUpdateGeo(),
		cmdStatus(),
		cmdEnsureWgNetworkd(),
		cmdDiagnostics(),
		cmdServe(),
		cmdBackup(),
		cmdRestore(),
		cmdDiscardPending(),
		cmdRestorePreviousApplied(),
		cmdPeerAdd(),
		cmdPeerRemove(),
		cmdPeerSet(),
		cmdValidate(),
	)
	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

func cmdVersion() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println(version)
		},
	}
}

func cmdReload() *cobra.Command {
	return &cobra.Command{
		Use:   "reload",
		Short: "Regenerate and apply WireGuard + nftables from config",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.Reload(cmd.Context(), cfgPath)
		},
	}
}

func cmdUpdateGeo() *cobra.Command {
	return &cobra.Command{
		Use:   "update-geo",
		Short: "Download country zones and refresh nftables geo sets",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.UpdateGeo(cmd.Context(), cfgPath)
		},
	}
}

func cmdStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show WireGuard and nftables summary",
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := apply.Status(cmd.Context(), cfgPath)
			if err != nil {
				return err
			}
			_, werr := fmt.Print(out)
			return werr
		},
	}
}

func cmdEnsureWgNetworkd() *cobra.Command {
	return &cobra.Command{
		Use:   "ensure-wg-networkd",
		Short: "Install systemd-networkd Unmanaged=yes drop-in for the WireGuard iface (no-op without networkd/netplan)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.EnsureWireGuardUnmanagedFromConfig(cfgPath)
		},
	}
}

func cmdDiagnostics() *cobra.Command {
	var outPath string
	c := &cobra.Command{
		Use:   "diagnostics",
		Short: "Write a Markdown host diagnostics report (also available via GET /api/v1/diagnostics.md)",
		RunE: func(cmd *cobra.Command, args []string) error {
			md, filename, err := apply.BuildDiagnosticsMarkdown(cmd.Context(), cfgPath, apply.DiagnosticsMeta{
				Version: version,
			})
			if err != nil {
				return err
			}
			path := strings.TrimSpace(outPath)
			if path == "" {
				_, err := fmt.Fprint(cmd.OutOrStdout(), string(md))
				return err
			}
			if err := os.WriteFile(path, md, 0o600); err != nil {
				return err
			}
			fmt.Fprintf(cmd.ErrOrStderr(), "wrote %s (%s)\n", path, filename)
			return nil
		},
	}
	c.Flags().StringVarP(&outPath, "output", "o", "", "write report to file (default: stdout)")
	return c
}

func cmdServe() *cobra.Command {
	var listen, tokenFile, corsOrigins, metricsDB, metricsListen string
	var metricsListenInsecure bool
	c := &cobra.Command{
		Use:   "serve",
		Short: "Run local HTTP API (binds 127.0.0.1 by default)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if ld := strings.TrimSpace(os.Getenv("EVUPROXY_LOG_DIR")); ld != "" {
				cleanup, err := logging.SetupFileAndStderr(ld)
				if err != nil {
					return err
				}
				defer cleanup()
			}
			tok := strings.TrimSpace(os.Getenv("EVUPROXY_API_TOKEN"))
			if tokenFile != "" {
				b, err := os.ReadFile(tokenFile)
				if err != nil {
					return err
				}
				tok = strings.TrimSpace(string(b))
			}
			ml := strings.TrimSpace(metricsListen)
			if ml == "" {
				ml = strings.TrimSpace(os.Getenv("EVUPROXY_METRICS_LISTEN"))
			}
			if ml != "" {
				if err := observability.ValidateMetricsListen(ml); err != nil {
					if !metricsListenInsecure {
						return fmt.Errorf("metrics listen: %w (use --metrics-listen-insecure to bind anyway)", err)
					}
					slog.Warn("metrics listen (insecure override)", "err", err)
				}
			}
			s := &api.Server{
				Listen:                listen,
				MetricsListen:         ml,
				MetricsListenInsecure: metricsListenInsecure,
				Token:                 tok,
				Config:                cfgPath,
				MetricsDB:             strings.TrimSpace(metricsDB),
				Logger:                slog.Default(),
				Version:               version,
				CORSOrigins:           corsOrigins,
			}
			geopath := strings.TrimSpace(os.Getenv("EVUPROXY_GEOLITE_MMDB"))
			if geopath != "" {
				r, err := geoip2.Open(geopath)
				if err != nil {
					// systemd often surfaces only the unit state in status output; stderr is in journal.
					fmt.Fprintf(os.Stderr,
						"evuproxy serve: cannot open GeoIP database (EVUPROXY_GEOLITE_MMDB=%q): %v\n"+
							"Starting without log country flags; GET /api/v1/logs will omit line_geo.\n",
						geopath, err)
				} else {
					defer r.Close()
					s.GeoIP = r
				}
			}
			return s.Run()
		},
	}
	c.Flags().StringVar(&listen, "listen", "127.0.0.1:9847", "listen address")
	c.Flags().StringVar(&tokenFile, "token-file", "/etc/evuproxy/api.token", "file containing API bearer token")
	c.Flags().StringVar(&corsOrigins, "cors-origins", "", "comma-separated allowed Origin values for cross-origin browser UIs; avoid * except local dev (token auth still required)")
	c.Flags().StringVar(&metricsDB, "metrics-db", "", "peer metrics SQLite path (default: metrics.sqlite beside --config)")
	c.Flags().StringVar(&metricsListen, "metrics-listen", "", "optional loopback Prometheus scrape address (e.g. 127.0.0.1:9848); also EVUPROXY_METRICS_LISTEN")
	c.Flags().BoolVar(&metricsListenInsecure, "metrics-listen-insecure", false, "allow --metrics-listen on non-loopback addresses (unauthenticated /metrics)")
	return c
}

func cmdBackup() *cobra.Command {
	var dest string
	c := &cobra.Command{
		Use:   "backup",
		Short: "Archive /etc/evuproxy directory (parent of config) to a .tgz file",
		RunE: func(cmd *cobra.Command, args []string) error {
			if dest == "" {
				return fmt.Errorf("--dest required")
			}
			return apply.Backup(cmd.Context(), cfgPath, dest)
		},
	}
	c.Flags().StringVar(&dest, "dest", "", "output .tgz path (absolute or cwd-relative; must resolve under EVUPROXY_BACKUP_DIR, default /var/backups)")
	return c
}

func cmdRestore() *cobra.Command {
	var archive string
	c := &cobra.Command{
		Use:   "restore",
		Short: "Extract backup tarball into /etc/evuproxy",
		RunE: func(cmd *cobra.Command, args []string) error {
			if archive == "" {
				return fmt.Errorf("--archive required")
			}
			return apply.Restore(cfgPath, archive)
		},
	}
	c.Flags().StringVar(&archive, "archive", "", "path to .tgz (absolute or cwd-relative; must resolve under EVUPROXY_BACKUP_DIR, default /var/backups)")
	return c
}

func cmdDiscardPending() *cobra.Command {
	return &cobra.Command{
		Use:   "discard-pending",
		Short: "Replace config.yaml with config.yaml.bak when they differ",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.DiscardPendingConfigYAML(cfgPath)
		},
	}
}

func cmdRestorePreviousApplied() *cobra.Command {
	return &cobra.Command{
		Use:   "restore-previous-applied",
		Short: "Replace config.yaml with the first config.yaml.bak.N that differs from .bak (see docs)",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.RestorePreviousAppliedConfigYAML(cfgPath)
		},
	}
}

func cmdPeerAdd() *cobra.Command {
	var name, publicKey, tunnelIP, privateKeyOut string
	var printGeneratedKey, doApply bool
	c := &cobra.Command{
		Use:   "peer-add",
		Short: "Append a WireGuard peer to config.yaml (validates; use --apply to reload)",
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("--name is required")
			}
			cfg, err := config.Load(cfgPath)
			if err != nil {
				return err
			}
			for _, p := range cfg.Peers {
				if !p.Disabled && strings.EqualFold(strings.TrimSpace(p.Name), strings.TrimSpace(name)) {
					return fmt.Errorf("peer named %q already exists", name)
				}
			}
			pub := strings.TrimSpace(publicKey)
			if pub == "" {
				if strings.TrimSpace(privateKeyOut) == "" && !printGeneratedKey {
					return fmt.Errorf("when omitting --public-key, set --private-key-out or --print-generated-key (avoid --print-generated-key in production logs; see evuproxy peer-add --help)")
				}
				priv, err := apply.GenerateWireGuardPrivateKey()
				if err != nil {
					return err
				}
				pub, err = apply.WireGuardPublicKey(priv)
				if err != nil {
					return err
				}
				if out := strings.TrimSpace(privateKeyOut); out != "" {
					p := filepath.Clean(out)
					if err := os.WriteFile(p, []byte(strings.TrimSpace(priv)+"\n"), 0o600); err != nil {
						return err
					}
					_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "wrote new peer private key to %s (0600); keep it secret on the client only\n", p)
				}
				if printGeneratedKey {
					_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "generated WireGuard private key for the new peer (keep secret on client only):\n%s\n\n", priv)
				}
			}
			tun := strings.TrimSpace(tunnelIP)
			if tun == "" {
				tun, err = apply.NextFreeTunnelIP(cfgPath, cfg)
				if err != nil {
					return err
				}
				_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "assigned tunnel_ip %s\n", tun)
			}
			cfg.Peers = append(cfg.Peers, config.Peer{Name: strings.TrimSpace(name), PublicKey: pub, TunnelIP: tun})
			if err := apply.SaveConfigYAML(cfgPath, cfg); err != nil {
				return err
			}
			if doApply {
				return apply.Reload(cmd.Context(), cfgPath)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "peer name (required)")
	c.Flags().StringVar(&publicKey, "public-key", "", "peer WireGuard public key (generated if omitted)")
	c.Flags().StringVar(&privateKeyOut, "private-key-out", "", "when generating a key pair, write the private key to this path (0600)")
	c.Flags().BoolVar(&printGeneratedKey, "print-generated-key", false, "when generating a key pair, also print the private key to stderr (avoid in production logs)")
	c.Flags().StringVar(&tunnelIP, "tunnel-ip", "", "tunnel address e.g. 10.100.0.5/32 (auto if omitted)")
	c.Flags().BoolVar(&doApply, "apply", false, "run reload after saving")
	return c
}

func cmdValidate() *cobra.Command {
	var jsonOut bool
	c := &cobra.Command{
		Use:   "validate",
		Short: "Validate config and generated nftables (dry-run, no apply)",
		RunE: func(cmd *cobra.Command, args []string) error {
			code, err := apply.ValidateConfigFileCLI(cfgPath, jsonOut, apply.ClientIPInfo{Source: apply.ClientIPSourceUnavailable}, nil)
			if err != nil {
				return err
			}
			if code != 0 {
				return fmt.Errorf("validation failed")
			}
			return nil
		},
	}
	c.Flags().BoolVar(&jsonOut, "json", false, "print result as JSON on stdout")
	return c
}

func cmdPeerRemove() *cobra.Command {
	var name, publicKey string
	var doApply bool
	c := &cobra.Command{
		Use:   "peer-remove",
		Short: "Remove a WireGuard peer from config.yaml",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := config.Load(cfgPath)
			if err != nil {
				return err
			}
			if err := apply.RemovePeerByNameOrKey(cfg, name, publicKey); err != nil {
				return err
			}
			if err := apply.SaveConfigYAML(cfgPath, cfg); err != nil {
				return err
			}
			if doApply {
				return apply.Reload(cmd.Context(), cfgPath)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "peer name to remove")
	c.Flags().StringVar(&publicKey, "public-key", "", "peer public key to remove")
	c.Flags().BoolVar(&doApply, "apply", false, "run reload after saving")
	return c
}

func cmdPeerSet() *cobra.Command {
	var name, newName, tunnelIP, publicKey string
	var disabled string
	var doApply bool
	c := &cobra.Command{
		Use:   "peer-set",
		Short: "Update fields on an existing WireGuard peer",
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("--name is required")
			}
			cfg, err := config.Load(cfgPath)
			if err != nil {
				return err
			}
			upd := apply.PeerSetUpdates{
				NewName:   newName,
				TunnelIP:  tunnelIP,
				PublicKey: publicKey,
			}
			if disabled != "" {
				switch strings.ToLower(strings.TrimSpace(disabled)) {
				case "true", "1", "yes":
					v := true
					upd.Disabled = &v
				case "false", "0", "no":
					v := false
					upd.Disabled = &v
				default:
					return fmt.Errorf("--disabled must be true or false")
				}
			}
			if err := apply.UpdatePeerByName(cfg, name, upd); err != nil {
				return err
			}
			if err := apply.SaveConfigYAML(cfgPath, cfg); err != nil {
				return err
			}
			if doApply {
				return apply.Reload(cmd.Context(), cfgPath)
			}
			return nil
		},
	}
	c.Flags().StringVar(&name, "name", "", "peer name (required)")
	c.Flags().StringVar(&newName, "new-name", "", "rename peer")
	c.Flags().StringVar(&tunnelIP, "tunnel-ip", "", "new tunnel address")
	c.Flags().StringVar(&publicKey, "public-key", "", "new public key")
	c.Flags().StringVar(&disabled, "disabled", "", "true or false")
	c.Flags().BoolVar(&doApply, "apply", false, "run reload after saving")
	return c
}
