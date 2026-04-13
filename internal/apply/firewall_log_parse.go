package apply

import (
	"regexp"
	"strings"
)

var fwLogSrcRE = regexp.MustCompile(`\bSRC=([^\s]+)`)
var fwLogDstRE = regexp.MustCompile(`\bDST=([^\s]+)`)

const fwKernelMarker = " kernel: "

func firewallLogBody(line string) string {
	if i := strings.Index(line, fwKernelMarker); i >= 0 {
		return line[i+len(fwKernelMarker):]
	}
	return line
}

// FirewallLogSrcDST returns the first SRC= and DST= token values from a firewall / kernel log line.
// When the line is journalctl short-iso output, only the payload after " kernel: " is scanned (same as the web UI parser).
func FirewallLogSrcDST(line string) (src, dst string) {
	body := firewallLogBody(line)
	if m := fwLogSrcRE.FindStringSubmatch(body); len(m) == 2 {
		src = m[1]
	}
	if m := fwLogDstRE.FindStringSubmatch(body); len(m) == 2 {
		dst = m[1]
	}
	return src, dst
}
