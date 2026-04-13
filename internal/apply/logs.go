package apply

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
)

// Log prefixes emitted by generated nftables (see internal/gen/nftables.go).
const (
	LogPrefixGeoBlock    = "evuproxy-geo-block"
	LogPrefixForwardDrop = "evuproxy-forward-drop"
)

// FirewallDropLogs returns recent lines for geoblock and forward drop events.
// It prefers journalctl (newest first); if that fails, falls back to dmesg.
func FirewallDropLogs(ctx context.Context, limit int) ([]string, string, error) {
	if limit < 1 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}
	lines, err := journalctlDropLines(ctx)
	if err == nil {
		return headLimit(lines, limit), "journalctl", nil
	}
	lines2, err2 := dmesgDropLines(ctx)
	if err2 != nil {
		return nil, "", fmt.Errorf("journalctl: %v; dmesg: %v", err, err2)
	}
	return headLimit(lines2, limit), "dmesg", nil
}

func journalctlDropLines(ctx context.Context) ([]string, error) {
	// Cap journal lines read: filtering keeps only drop-related rows; lower -n reduces journal I/O.
	cmd := exec.CommandContext(ctx, "journalctl", "-b", "--no-pager", "-n", "6000", "-o", "short-iso", "-r")
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	return filterDropLines(string(out)), nil
}

func dmesgDropLines(ctx context.Context) ([]string, error) {
	cmd := exec.CommandContext(ctx, "dmesg", "-T")
	out, err := cmd.Output()
	if err != nil {
		cmd = exec.CommandContext(ctx, "dmesg")
		out, err = cmd.Output()
		if err != nil {
			return nil, err
		}
	}
	lines := filterDropLines(string(out))
	reverseStrings(lines)
	return lines, nil
}

func filterDropLines(blob string) []string {
	var out []string
	for _, line := range strings.Split(blob, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.Contains(line, LogPrefixGeoBlock) || strings.Contains(line, LogPrefixForwardDrop) {
			out = append(out, line)
		}
	}
	return out
}

func headLimit(lines []string, limit int) []string {
	if len(lines) <= limit {
		return lines
	}
	return lines[:limit]
}

func reverseStrings(s []string) {
	for i, j := 0, len(s)-1; i < j; i, j = i+1, j-1 {
		s[i], s[j] = s[j], s[i]
	}
}
