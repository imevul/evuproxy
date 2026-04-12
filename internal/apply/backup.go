package apply

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// Backup creates a gzip tarball of /etc/evuproxy (parent of config file).
func Backup(configPath, dest string) error {
	root := filepath.Dir(configPath)
	if d := filepath.Dir(dest); d != "." && d != "/" {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return err
		}
	}
	cmd := exec.Command("tar", "-czf", dest, "-C", root, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar: %w: %s", err, out)
	}
	return nil
}

// Restore extracts a tarball produced by Backup into /etc/evuproxy.
func Restore(configPath, archive string) error {
	root := filepath.Dir(configPath)
	cmd := exec.Command("tar", "-xzf", archive, "-C", root)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar extract: %w: %s", err, out)
	}
	return nil
}
