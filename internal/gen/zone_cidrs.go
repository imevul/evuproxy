package gen

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/imevul/evuproxy/internal/config"
)

// ZoneCIDRsForCountries reads IPDeny-style zone files and returns unique CIDR lines.
func ZoneCIDRsForCountries(zoneDir string, countries []string) ([]string, error) {
	seen := map[string]struct{}{}
	var out []string
	for _, cc := range countries {
		cc = strings.ToLower(strings.TrimSpace(cc))
		if cc == "" {
			continue
		}
		if err := config.ValidateCountryCode(cc); err != nil {
			return nil, err
		}
		path := filepath.Join(zoneDir, cc+".zone")
		f, err := os.Open(path)
		if err != nil {
			return nil, fmt.Errorf("zone file %s: %w", path, err)
		}
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			line := strings.TrimSpace(sc.Text())
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if _, ok := seen[line]; ok {
				continue
			}
			seen[line] = struct{}{}
			out = append(out, line)
		}
		_ = f.Close()
		if err := sc.Err(); err != nil {
			return nil, err
		}
	}
	return out, nil
}
