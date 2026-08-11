package apply

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/eventlog"
	"github.com/imevul/evuproxy/internal/state"
)

const (
	diagnosticsRepoBlobBase = "https://github.com/imevul/evuproxy/blob/main/"
	diagnosticsMaxProbeOut  = 96 << 10
	diagnosticsMaxNFTOut    = 128 << 10
)

var privateKeyLineRE = regexp.MustCompile(`(?i)^\s*private[_\s-]?key\s*[:=]`)

// DiagnosticsMeta carries accurate identity from the CLI/API process.
type DiagnosticsMeta struct {
	Version     string
	GeneratedAt time.Time // zero → time.Now().UTC()
}

// uiDockerInfo is best-effort identity of the running admin UI container.
type uiDockerInfo struct {
	Detected bool
	Image    string
	ImageID  string
	Created  string
	OCIVer   string
	OCIRev   string
	Note     string
}

type diagProbe struct {
	Title   string
	Command string
	Exit    int // -1 when skipped / not run as a shell command
	Output  string
	Notes   string
	Failed  bool
	Skipped bool
}

// BuildDiagnosticsMarkdown collects host debug evidence into a structured Markdown report.
func BuildDiagnosticsMarkdown(ctx context.Context, cfgPath string, meta DiagnosticsMeta) (markdown []byte, filename string, err error) {
	if ctx == nil {
		ctx = context.Background()
	}
	generated := meta.GeneratedAt
	if generated.IsZero() {
		generated = time.Now().UTC()
	} else {
		generated = generated.UTC()
	}
	ver := strings.TrimSpace(meta.Version)
	if ver == "" {
		ver = "dev"
	}
	cfgPath = strings.TrimSpace(cfgPath)
	if cfgPath == "" {
		cfgPath = "/etc/evuproxy/config.yaml"
	}

	hostname, _ := os.Hostname()
	c, cfgErr := config.Load(cfgPath)
	iface := "evuproxy0"
	listenPort := 0
	pubIF := ""
	if c != nil {
		if s := strings.TrimSpace(c.WireGuard.Interface); s != "" {
			iface = s
		}
		listenPort = c.WireGuard.ListenPort
		pubIF = strings.TrimSpace(c.Network.PublicInterface)
	}

	ui := probeUIDocker(ctx)
	var probes []diagProbe
	var failed []string

	addCmd := func(title string, notes string, name string, args ...string) {
		p := runDiagProbe(ctx, title, notes, name, args...)
		probes = append(probes, p)
		if p.Failed {
			failed = append(failed, fmt.Sprintf("%s: %s", p.Command, strings.TrimSpace(firstLine(p.Output))))
		}
	}
	addStatic := func(title, command, notes, output string, failedProbe bool) {
		p := diagProbe{
			Title:   title,
			Command: command,
			Exit:    0,
			Output:  redactDiagnostics(truncateDiagnostics(output, diagnosticsMaxProbeOut)),
			Notes:   notes,
			Failed:  failedProbe,
		}
		if failedProbe {
			p.Exit = 1
			failed = append(failed, title+": "+firstLine(output))
		}
		probes = append(probes, p)
	}
	addSkipped := func(title, command, reason string) {
		probes = append(probes, diagProbe{
			Title:   title,
			Command: command,
			Exit:    -1,
			Skipped: true,
			Notes:   reason,
			Output:  reason,
		})
		failed = append(failed, title+": skipped — "+reason)
	}

	addCmd("uname", "", "uname", "-a")

	if cfgErr != nil {
		addStatic("config (sanitized)", "config.Load("+cfgPath+")", "config load failed", cfgErr.Error(), true)
	} else {
		sanitized, err := sanitizedConfigYAML(c)
		if err != nil {
			addStatic("config (sanitized)", "yaml.Marshal(sanitized config)", "", err.Error(), true)
		} else {
			addStatic("config (sanitized)", "config.Load + sanitize", "private_key_file path only; key material not read", sanitized, false)
		}
	}

	var warnings []WireGuardHostWarning
	if c != nil {
		warnings = WireGuardHostWarnings(ctx, c, cfgPath)
		if len(warnings) == 0 {
			addStatic("host warnings", "WireGuardHostWarnings", "", "(none)", false)
		} else {
			var b strings.Builder
			for _, w := range warnings {
				fmt.Fprintf(&b, "- **%s:** %s\n", w.Code, w.Message)
			}
			addStatic("host warnings", "WireGuardHostWarnings", "", b.String(), false)
		}
	} else {
		addSkipped("host warnings", "WireGuardHostWarnings", "config not loaded")
	}

	addCmd("wg show", "", "wg", "show")
	addCmd("wg show "+iface, "", "wg", "show", iface)

	addCmd("ip -4 addr show", "", "ip", "-4", "addr", "show")
	addCmd("ip -4 addr show dev "+iface, "", "ip", "-4", "addr", "show", "dev", iface)

	if c != nil {
		for _, p := range c.Peers {
			if p.Disabled {
				continue
			}
			tip := config.PeerTunnelIPv4(p.TunnelIP)
			if tip == "" {
				continue
			}
			addCmd("ip route get "+tip, "peer "+strings.TrimSpace(p.Name), "ip", "route", "get", tip)
		}
	}
	addCmd("ip -4 route show", "", "ip", "-4", "route", "show")
	addCmd("ip rule list", "", "ip", "rule", "list")

	if listenPort > 0 {
		addCmd("ss -ulnp (WG listen port)", fmt.Sprintf("filter udp port %d", listenPort), "ss", "-ulnp")
		// Filter client-side for the port to keep the section focused.
		if len(probes) > 0 {
			last := &probes[len(probes)-1]
			if !last.Failed && !last.Skipped {
				last.Output = filterSSPort(last.Output, listenPort)
				if strings.TrimSpace(last.Output) == "" {
					last.Output = fmt.Sprintf("(no ss lines mentioning :%d)", listenPort)
				}
			}
		}
	} else {
		addSkipped("ss -ulnp (WG listen port)", "ss -ulnp", "listen_port unknown")
	}

	netPath := WireGuardUnmanagedNetworkPath(iface)
	if b, err := os.ReadFile(netPath); err == nil {
		addStatic("systemd-networkd drop-in", "read "+netPath, "", string(b), false)
	} else {
		legacy := filepath.Join(systemdNetworkDir, "80-"+iface+".network")
		if b2, err2 := os.ReadFile(legacy); err2 == nil {
			addStatic("systemd-networkd drop-in (legacy 80-)", "read "+legacy, "prefer 00- prefix; migrate with ensure-wg-networkd", string(b2), false)
		} else {
			addSkipped("systemd-networkd drop-in", "read "+netPath, "not present")
		}
	}
	addCmd("networkctl status "+iface, "may fail if networkctl/networkd absent", "networkctl", "status", iface)

	netplanNote := "netplan present: no"
	matches, _ := filepath.Glob("/etc/netplan/*.yaml")
	matches2, _ := filepath.Glob("/etc/netplan/*.yml")
	allNetplan := append(matches, matches2...)
	if len(allNetplan) > 0 {
		netplanNote = "netplan present: yes\nfilenames:\n- " + strings.Join(allNetplan, "\n- ")
	}
	addStatic("netplan filenames", "glob /etc/netplan/*.{yaml,yml}", "contents omitted (may contain secrets)", netplanNote, false)

	addCmd("sysctl net.ipv4.ip_forward", "", "sysctl", "net.ipv4.ip_forward")

	addCmd("nft list table inet evuproxy", "", "nft", "list", "table", "inet", "evuproxy")
	if len(probes) > 0 {
		last := &probes[len(probes)-1]
		if !last.Failed {
			last.Output = truncateDiagnostics(last.Output, diagnosticsMaxNFTOut)
		}
	}
	addCmd("nft list table ip evuproxy", "", "nft", "list", "table", "ip", "evuproxy")
	if len(probes) > 0 {
		last := &probes[len(probes)-1]
		if !last.Failed {
			last.Output = truncateDiagnostics(last.Output, diagnosticsMaxNFTOut)
		}
	}

	for _, unit := range []string{"evuproxy.service", "evuproxy-api.service", "systemd-networkd.service"} {
		addCmd("systemctl is-active "+unit, "", "systemctl", "is-active", unit)
		addCmd("systemctl is-enabled "+unit, "", "systemctl", "is-enabled", unit)
	}
	addCmd("journalctl evuproxy units", "last 150 lines", "journalctl",
		"-u", "evuproxy.service", "-u", "evuproxy-api.service", "-n", "150", "--no-pager")

	dropLines, dropSrc, dropErr := FirewallDropLogs(ctx, 80)
	if dropErr != nil {
		addStatic("firewall drop logs", "FirewallDropLogs", "", dropErr.Error(), true)
	} else {
		body := strings.Join(dropLines, "\n")
		if body == "" {
			body = "(no matching drop lines)"
		}
		addStatic("firewall drop logs", "FirewallDropLogs", "source="+dropSrc, body, false)
	}

	// DOCKER-USER existence (forward-timeout class). Not a hard failure if missing.
	out, dockerErr := runCmdCombined(ctx, "nft", "list", "chain", "ip", "filter", "DOCKER-USER")
	if dockerErr != nil {
		msg := strings.TrimSpace(string(out))
		if msg != "" {
			msg += "\n"
		}
		msg += dockerErr.Error()
		addStatic("DOCKER-USER chain", "nft list chain ip filter DOCKER-USER",
			"missing or error — can cause forward timeouts on Docker hosts (see References)", msg, false)
		probes[len(probes)-1].Exit = 1
	} else {
		addStatic("DOCKER-USER chain", "nft list chain ip filter DOCKER-USER", "present",
			truncateDiagnostics(string(out), 8<<10), false)
	}

	if el, err := eventlog.New(filepath.Dir(cfgPath), eventlog.MaxBytesFromEnv()); err != nil {
		addSkipped("audit events", "eventlog.ReadTail", err.Error())
	} else {
		recs, err := el.ReadTail(30)
		if err != nil {
			addStatic("audit events", "eventlog.ReadTail(30)", "", err.Error(), true)
		} else if len(recs) == 0 {
			addStatic("audit events", "eventlog.ReadTail(30)", "", "(none)", false)
		} else {
			var b strings.Builder
			for _, r := range recs {
				fmt.Fprintf(&b, "- `%s` %s", r.Ts.UTC().Format(time.RFC3339), r.Event)
				if r.ErrorCode != "" {
					fmt.Fprintf(&b, " code=%s", r.ErrorCode)
				}
				if r.Detail != "" {
					fmt.Fprintf(&b, " — %s", TruncateForLog(r.Detail, 200))
				}
				b.WriteByte('\n')
			}
			addStatic("audit events", "eventlog.ReadTail(30)", "newest first", b.String(), false)
		}
	}

	pendingLine := "pending: unknown"
	if info, err := PendingSummary(cfgPath); err != nil {
		pendingLine = "pending: error: " + err.Error()
	} else {
		pendingLine = fmt.Sprintf("pending=%v current_sha256=%s applied_sha256=%s discard_available=%v restore_previous_available=%v",
			info.Pending, shortSHA(info.CurrentConfigSHA256), shortSHA(info.AppliedConfigSHA256),
			info.DiscardAvailable, info.RestorePreviousAppliedAvailable)
	}
	addStatic("pending apply", "PendingSummary", "", pendingLine, false)

	geo := state.ReadGeoLastSuccess(cfgPath)
	geoLine := "geo last success: (none recorded)"
	if strings.TrimSpace(geo.UTC) != "" {
		geoLine = fmt.Sprintf("geo last success: %s (source=%s)", geo.UTC, geo.Source)
	}

	filename = fmt.Sprintf("evuproxy-diagnostics-%s.md", generated.Format("20060102T150405Z"))
	md := renderDiagnosticsMarkdown(diagnosticsRenderInput{
		Generated:  generated,
		Version:    ver,
		Hostname:   hostname,
		ConfigPath: cfgPath,
		Iface:      iface,
		ListenPort: listenPort,
		PubIF:      pubIF,
		UI:         ui,
		CfgErr:     cfgErr,
		GeoLine:    geoLine,
		Pending:    pendingLine,
		Warnings:   warnings,
		Probes:     probes,
		Failed:     failed,
	})
	return []byte(md), filename, nil
}

type diagnosticsRenderInput struct {
	Generated  time.Time
	Version    string
	Hostname   string
	ConfigPath string
	Iface      string
	ListenPort int
	PubIF      string
	UI         uiDockerInfo
	CfgErr     error
	GeoLine    string
	Pending    string
	Warnings   []WireGuardHostWarning
	Probes     []diagProbe
	Failed     []string
}

func renderDiagnosticsMarkdown(in diagnosticsRenderInput) string {
	var b strings.Builder
	uiImage, uiID, uiCreated, uiVer, uiRev := "", "", "", "", ""
	uiStatus := "not detected"
	if in.UI.Detected {
		uiStatus = "detected"
		uiImage = in.UI.Image
		uiID = in.UI.ImageID
		uiCreated = in.UI.Created
		uiVer = in.UI.OCIVer
		uiRev = in.UI.OCIRev
	} else if in.UI.Note != "" {
		uiStatus = in.UI.Note
	}

	b.WriteString("---\n")
	fmt.Fprintf(&b, "title: EvuProxy host diagnostics\n")
	fmt.Fprintf(&b, "generated_utc: %s\n", in.Generated.Format(time.RFC3339))
	fmt.Fprintf(&b, "hostname: %q\n", in.Hostname)
	fmt.Fprintf(&b, "evuproxy_version: %q\n", in.Version)
	fmt.Fprintf(&b, "go_version: %q\n", runtime.Version())
	fmt.Fprintf(&b, "config_path: %q\n", in.ConfigPath)
	fmt.Fprintf(&b, "wireguard_interface: %q\n", in.Iface)
	fmt.Fprintf(&b, "listen_port: %d\n", in.ListenPort)
	fmt.Fprintf(&b, "public_interface: %q\n", in.PubIF)
	fmt.Fprintf(&b, "ui_docker_status: %q\n", uiStatus)
	if uiImage != "" {
		fmt.Fprintf(&b, "ui_docker_image: %q\n", uiImage)
	}
	if uiID != "" {
		fmt.Fprintf(&b, "ui_docker_image_id: %q\n", uiID)
	}
	if uiCreated != "" {
		fmt.Fprintf(&b, "ui_docker_created: %q\n", uiCreated)
	}
	if uiVer != "" {
		fmt.Fprintf(&b, "ui_oci_version: %q\n", uiVer)
	}
	if uiRev != "" {
		fmt.Fprintf(&b, "ui_oci_revision: %q\n", uiRev)
	}
	b.WriteString("---\n\n")

	b.WriteString("# EvuProxy host diagnostics\n\n")
	b.WriteString("Read-only support bundle collected on the **EvuProxy host**. Secrets (API token, private keys) are redacted or omitted. ")
	b.WriteString("This does **not** include peer-client `wg show` — attach that separately when debugging handshakes.\n\n")

	b.WriteString("## Identity\n\n")
	b.WriteString("| Field | Value |\n| --- | --- |\n")
	fmt.Fprintf(&b, "| Generated (UTC) | `%s` |\n", in.Generated.Format(time.RFC3339))
	fmt.Fprintf(&b, "| Hostname | `%s` |\n", mdCell(in.Hostname))
	fmt.Fprintf(&b, "| Host binary version | `%s` |\n", mdCell(in.Version))
	fmt.Fprintf(&b, "| Go runtime | `%s` |\n", runtime.Version())
	fmt.Fprintf(&b, "| Config path | `%s` |\n", mdCell(in.ConfigPath))
	fmt.Fprintf(&b, "| WireGuard interface | `%s` |\n", mdCell(in.Iface))
	fmt.Fprintf(&b, "| Listen port | `%d` |\n", in.ListenPort)
	fmt.Fprintf(&b, "| Public interface | `%s` |\n", mdCell(in.PubIF))
	if in.UI.Detected {
		fmt.Fprintf(&b, "| UI Docker image | `%s` |\n", mdCell(uiImage))
		fmt.Fprintf(&b, "| UI Docker image ID | `%s` |\n", mdCell(shortDockerID(uiID)))
		fmt.Fprintf(&b, "| UI Docker created | `%s` |\n", mdCell(uiCreated))
		if uiVer != "" {
			fmt.Fprintf(&b, "| UI OCI version | `%s` |\n", mdCell(uiVer))
		}
		if uiRev != "" {
			fmt.Fprintf(&b, "| UI OCI revision | `%s` |\n", mdCell(uiRev))
		}
	} else {
		fmt.Fprintf(&b, "| UI Docker | `%s` |\n", mdCell(uiStatus))
	}
	b.WriteByte('\n')

	b.WriteString("## References\n\n")
	b.WriteString("Domain knowledge for interpreting this report:\n\n")
	fmt.Fprintf(&b, "- WireGuard vs systemd-networkd / netplan (tunnel wipe, `e*`, `Unmanaged=yes`, recovery): %s\n",
		diagnosticsRepoBlobBase+"docs/config.md#wireguard-and-systemd-networkd--netplan")
	fmt.Fprintf(&b, "- Config / forwarding (route → non-disabled peer `tunnel_ip`; Docker `DOCKER-USER` timeouts): %s\n",
		diagnosticsRepoBlobBase+"docs/config.md")
	fmt.Fprintf(&b, "- HTTP API (auth, pending/reload, `host_warnings`): %s\n",
		diagnosticsRepoBlobBase+"docs/http-api.md")
	fmt.Fprintf(&b, "- Security and privacy (sharing caution, tokens): %s\n",
		diagnosticsRepoBlobBase+"docs/security-and-privacy.md")
	fmt.Fprintf(&b, "- README (install/update/backup): %s\n\n",
		diagnosticsRepoBlobBase+"README.md")

	b.WriteString("## How to read this\n\n")
	b.WriteString("1. Start with **Summary** and **Skipped / failed probes**.\n")
	b.WriteString("2. Treat fenced blocks under **Probes** as command evidence (exit code + stdout/stderr).\n")
	b.WriteString("3. Common patterns:\n")
	b.WriteString("   - Stale handshake on the host + peer shows `0 B received` → peer **Endpoint** wrong (e.g. Cloudflare-proxied hostname / IPv6 anycast). Fix peer config to the VPS IP:`listen_port`.\n")
	b.WriteString("   - Tunnel address missing on the WG iface + forwards with `OUT=eth0` / `evuproxy-forward-drop` → networkd/netplan wiped the address (see References).\n")
	b.WriteString("   - Published ports timeout with no forward-drop logs → check `DOCKER-USER` / `forward_allow_docker_bridges`.\n\n")

	b.WriteString("## Table of contents\n\n")
	b.WriteString("- [Identity](#identity)\n")
	b.WriteString("- [References](#references)\n")
	b.WriteString("- [How to read this](#how-to-read-this)\n")
	b.WriteString("- [Summary](#summary)\n")
	b.WriteString("- [Probes](#probes)\n")
	b.WriteString("- [Skipped / failed probes](#skipped--failed-probes)\n\n")

	b.WriteString("## Summary\n\n")
	fmt.Fprintf(&b, "- **Pending apply:** %s\n", in.Pending)
	fmt.Fprintf(&b, "- **%s**\n", in.GeoLine)
	if in.CfgErr != nil {
		fmt.Fprintf(&b, "- **Config load error:** %s\n", in.CfgErr.Error())
	}
	if len(in.Warnings) == 0 {
		b.WriteString("- **Host warnings:** none\n")
	} else {
		b.WriteString("- **Host warnings:**\n")
		for _, w := range in.Warnings {
			fmt.Fprintf(&b, "  - `%s`: %s\n", w.Code, w.Message)
		}
	}
	for _, p := range in.Probes {
		if p.Title == "wg show "+in.Iface || p.Title == "wg show" {
			if hs := summarizeWGHandshakes(p.Output); hs != "" {
				b.WriteString("- **WireGuard peers (from probe output):**\n")
				b.WriteString(hs)
			}
			break
		}
	}
	b.WriteString("\nRemind operators: attach peer-side `sudo wg show` when debugging client connectivity.\n\n")

	b.WriteString("## Probes\n\n")
	for _, p := range in.Probes {
		if p.Skipped {
			continue
		}
		fmt.Fprintf(&b, "### %s\n\n", p.Title)
		fmt.Fprintf(&b, "- **command:** `%s`\n", p.Command)
		fmt.Fprintf(&b, "- **exit:** %d\n", p.Exit)
		if p.Notes != "" {
			fmt.Fprintf(&b, "- **notes:** %s\n", p.Notes)
		}
		b.WriteString("\n```text\n")
		b.WriteString(ensureTrailingNewline(p.Output))
		b.WriteString("```\n\n")
	}

	b.WriteString("## Skipped / failed probes\n\n")
	if len(in.Failed) == 0 {
		b.WriteString("(none)\n")
	} else {
		for _, f := range in.Failed {
			fmt.Fprintf(&b, "- %s\n", f)
		}
	}
	b.WriteByte('\n')
	return b.String()
}

func runDiagProbe(ctx context.Context, title, notes, name string, args ...string) diagProbe {
	cmdStr := name
	if len(args) > 0 {
		cmdStr += " " + strings.Join(args, " ")
	}
	out, err := runCmdCombined(ctx, name, args...)
	p := diagProbe{
		Title:   title,
		Command: cmdStr,
		Notes:   notes,
		Output:  redactDiagnostics(truncateDiagnostics(string(out), diagnosticsMaxProbeOut)),
		Exit:    0,
	}
	if err != nil {
		p.Failed = true
		p.Exit = 1
		if p.Output == "" {
			p.Output = err.Error()
		} else {
			p.Output = strings.TrimRight(p.Output, "\n") + "\n" + err.Error()
		}
	}
	return p
}

func probeUIDocker(ctx context.Context) uiDockerInfo {
	info := uiDockerInfo{Note: "not detected"}
	// Prefer compose-style name, then any name containing evuproxy-ui.
	idOut, err := runCmdCombined(ctx, "docker", "ps", "--format", "{{.ID}}\t{{.Names}}")
	if err != nil {
		info.Note = "not detected (docker unavailable or not permitted)"
		return info
	}
	var containerID string
	for _, line := range strings.Split(string(idOut), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 2)
		name := ""
		if len(parts) == 2 {
			name = parts[1]
		}
		id := parts[0]
		lname := strings.ToLower(name)
		if strings.Contains(lname, "evuproxy-ui") || lname == "evuproxy-ui" {
			containerID = id
			break
		}
	}
	if containerID == "" {
		return info
	}
	format := "{{.Id}}|{{.Config.Image}}|{{.Created}}|{{index .Config.Labels \"org.opencontainers.image.version\"}}|{{index .Config.Labels \"org.opencontainers.image.revision\"}}"
	insp, err := runCmdCombined(ctx, "docker", "inspect", "--format", format, containerID)
	if err != nil {
		info.Note = "not detected (docker inspect failed)"
		return info
	}
	fields := strings.Split(strings.TrimSpace(string(insp)), "|")
	for len(fields) < 5 {
		fields = append(fields, "")
	}
	info.Detected = true
	info.Note = ""
	info.ImageID = fields[0]
	info.Image = fields[1]
	info.Created = fields[2]
	info.OCIVer = fields[3]
	info.OCIRev = fields[4]
	return info
}

func sanitizedConfigYAML(c *config.Config) (string, error) {
	if c == nil {
		return "", fmt.Errorf("nil config")
	}
	// Shallow copy via YAML round-trip to avoid mutating caller's config.
	raw, err := yaml.Marshal(c)
	if err != nil {
		return "", err
	}
	var m map[string]any
	if err := yaml.Unmarshal(raw, &m); err != nil {
		return "", err
	}
	if wg, ok := m["wireguard"].(map[string]any); ok {
		if v, ok := wg["private_key_file"]; ok {
			wg["private_key_file"] = fmt.Sprintf("%v", v) // path only; never read file
		}
		delete(wg, "private_key")
	}
	out, err := yaml.Marshal(m)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func redactDiagnostics(s string) string {
	var b strings.Builder
	for _, line := range strings.Split(s, "\n") {
		if privateKeyLineRE.MatchString(line) {
			b.WriteString("private key: (redacted)\n")
			continue
		}
		b.WriteString(line)
		b.WriteByte('\n')
	}
	return strings.TrimSuffix(b.String(), "\n")
}

func truncateDiagnostics(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	orig := len(s)
	s = TruncateForLog(s, max)
	return fmt.Sprintf("%s\n… truncated (%d bytes total, showing up to %d) …", s, orig, max)
}

func filterSSPort(ssOut string, port int) string {
	needle := fmt.Sprintf(":%d", port)
	var keep []string
	for _, line := range strings.Split(ssOut, "\n") {
		if strings.Contains(line, needle) || strings.HasPrefix(line, "State") || strings.HasPrefix(line, "Netid") {
			keep = append(keep, line)
		}
	}
	return strings.Join(keep, "\n")
}

func summarizeWGHandshakes(wgOut string) string {
	var b strings.Builder
	var peer string
	for _, line := range strings.Split(wgOut, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "peer:") {
			peer = strings.TrimSpace(strings.TrimPrefix(line, "peer:"))
			if len(peer) > 20 {
				peer = peer[:20] + "…"
			}
			continue
		}
		if peer != "" && strings.HasPrefix(line, "latest handshake:") {
			fmt.Fprintf(&b, "  - peer `%s`: %s\n", peer, strings.TrimPrefix(line, "latest handshake:"))
			peer = ""
		}
		if peer != "" && strings.HasPrefix(line, "transfer:") {
			fmt.Fprintf(&b, "  - peer `%s`: (no handshake line) %s\n", peer, line)
			peer = ""
		}
	}
	return b.String()
}

func shortSHA(s string) string {
	s = strings.TrimSpace(s)
	if len(s) > 12 {
		return s[:12] + "…"
	}
	if s == "" {
		return "(empty)"
	}
	return s
}

func shortDockerID(id string) string {
	id = strings.TrimSpace(id)
	id = strings.TrimPrefix(id, "sha256:")
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func mdCell(s string) string {
	s = strings.ReplaceAll(s, "|", "\\|")
	s = strings.ReplaceAll(s, "\n", " ")
	if s == "" {
		return "—"
	}
	return s
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
}

func ensureTrailingNewline(s string) string {
	if s == "" {
		return "\n"
	}
	if strings.HasSuffix(s, "\n") {
		return s
	}
	return s + "\n"
}
