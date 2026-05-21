package apply

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const crowdsecInstallModeFile = "crowdsec-install-mode"

// tryRestartCrowdsecBouncer optionally restarts the CrowdSec nftables bouncer after reload
// when EVUPROXY_CROWDSEC_BOUNCER_RESTART=1 (off by default).
func tryRestartCrowdsecBouncer(cfgPath string) {
	if strings.TrimSpace(os.Getenv("EVUPROXY_CROWDSEC_BOUNCER_RESTART")) != "1" {
		return
	}
	mode := readCrowdsecInstallMode(filepath.Dir(cfgPath))
	switch mode {
	case "native":
		_ = exec.Command("systemctl", "try-restart", "crowdsec-firewall-bouncer.service").Run()
	case "docker":
		// Docker compose path is operator-specific; see contrib/crowdsec/README.md.
	default:
	}
}

func readCrowdsecInstallMode(configDir string) string {
	if p := filepath.Join(configDir, crowdsecInstallModeFile); p != "" {
		if b, err := os.ReadFile(p); err == nil {
			m := strings.TrimSpace(string(b))
			if m == "docker" || m == "native" {
				return m
			}
		}
	}
	return ""
}
