package main

import (
	"fmt"
	"log/slog"
	"os"
	"strings"

	"github.com/imevul/evuproxy/internal/api"
	"github.com/imevul/evuproxy/internal/apply"
	"github.com/spf13/cobra"
)

var (
	version = "0.1.0"
	cfgPath string
)

func main() {
	root := &cobra.Command{
		Use:   "evuproxy",
		Short: "EvuProxy — WireGuard + nftables forwarding control",
	}
	root.PersistentFlags().StringVar(&cfgPath, "config", "/etc/evuproxy/config.yaml", "path to evuproxy config")

	root.AddCommand(
		cmdVersion(),
		cmdReload(),
		cmdUpdateGeo(),
		cmdStatus(),
		cmdServe(),
		cmdBackup(),
		cmdRestore(),
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
			return apply.Reload(cfgPath)
		},
	}
}

func cmdUpdateGeo() *cobra.Command {
	return &cobra.Command{
		Use:   "update-geo",
		Short: "Download country zones and refresh nftables geo sets",
		RunE: func(cmd *cobra.Command, args []string) error {
			return apply.UpdateGeo(cfgPath)
		},
	}
}

func cmdStatus() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show WireGuard and nftables summary",
		RunE: func(cmd *cobra.Command, args []string) error {
			out, err := apply.Status(cfgPath)
			if err != nil {
				return err
			}
			_, werr := fmt.Print(out)
			return werr
		},
	}
}

func cmdServe() *cobra.Command {
	var listen, tokenFile string
	c := &cobra.Command{
		Use:   "serve",
		Short: "Run local HTTP API (bind127.0.0.1 by default)",
		RunE: func(cmd *cobra.Command, args []string) error {
			tok := strings.TrimSpace(os.Getenv("EVUPROXY_API_TOKEN"))
			if tokenFile != "" {
				b, err := os.ReadFile(tokenFile)
				if err != nil {
					return err
				}
				tok = strings.TrimSpace(string(b))
			}
			s := &api.Server{
				Listen: listen,
				Token:  tok,
				Config: cfgPath,
				Logger: slog.Default(),
			}
			return s.Run()
		},
	}
	c.Flags().StringVar(&listen, "listen", "127.0.0.1:9847", "listen address")
	c.Flags().StringVar(&tokenFile, "token-file", "/etc/evuproxy/api.token", "file containing API bearer token")
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
			return apply.Backup(cfgPath, dest)
		},
	}
	c.Flags().StringVar(&dest, "dest", "", "output path e.g. /root/evuproxy-backup.tgz")
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
	c.Flags().StringVar(&archive, "archive", "", "path to .tgz from evuproxy backup")
	return c
}
