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
	LogPrefixRateLimit   = "evuproxy-ratelimit"
	LogPrefixForwardDrop = "evuproxy-forward-drop"
	LogPrefixCrowdsec    = "evuproxy-crowdsec"
)

// FirewallDropLogs returns recent lines for geoblock and forward drop events.
// It prefers journalctl kernel messages (newest first). If that fails or yields
// no matches, it falls back to dmesg. A plain "last N journal lines" read is not
// enough on busy hosts: userspace spam can push nft drop lines out of the window
// while they remain in the kernel ring buffer.
func FirewallDropLogs(ctx context.Context, limit int) ([]string, string, error) {
	if limit < 1 {
		limit = 200
	}
	if limit > 2000 {
		limit = 2000
	}
	lines, err := journalctlDropLines(ctx)
	var lines2 []string
	var err2 error
	if err != nil || len(lines) == 0 {
		lines2, err2 = dmesgDropLines(ctx)
	}
	out, source, pickErr := pickFirewallLogSource(lines, err, lines2, err2)
	if pickErr != nil {
		return nil, "", pickErr
	}
	out = headLimit(out, limit)
	if out == nil {
		out = []string{}
	}
	return out, source, nil
}

// pickFirewallLogSource chooses journalctl vs dmesg results.
func pickFirewallLogSource(journal []string, journalErr error, dmesg []string, dmesgErr error) ([]string, string, error) {
	if journalErr == nil && len(journal) > 0 {
		return journal, "journalctl", nil
	}
	if dmesgErr == nil && len(dmesg) > 0 {
		return dmesg, "dmesg", nil
	}
	if journalErr == nil {
		// Empty journal (and empty or failed dmesg): still a successful empty read.
		return nil, "journalctl", nil
	}
	if dmesgErr == nil {
		return nil, "dmesg", nil
	}
	return nil, "", fmt.Errorf("journalctl: %v; dmesg: %v", journalErr, dmesgErr)
}

func journalctlDropLines(ctx context.Context) ([]string, error) {
	// -k: kernel messages only. Without it, -n counts every unit and busy
	// userspace can starve nft drop lines out of the window.
	cmd := exec.CommandContext(ctx, "journalctl", "-k", "-b", "--no-pager", "-n", "6000", "-o", "short-iso", "-r")
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
		if strings.Contains(line, LogPrefixGeoBlock) || strings.Contains(line, LogPrefixForwardDrop) || strings.Contains(line, LogPrefixRateLimit) || strings.Contains(line, LogPrefixCrowdsec) {
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
