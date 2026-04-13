package apply

import "testing"

func TestFirewallLogSrcDST(t *testing.T) {
	line := "2026-01-15T10:00:02+00:00 host kernel: evuproxy-forward-drop: IN=eth0 OUT=docker0 SRC=10.0.0.5 DST=172.17.0.2 LEN=60 PROTO=TCP"
	src, dst := FirewallLogSrcDST(line)
	if src != "10.0.0.5" || dst != "172.17.0.2" {
		t.Fatalf("got %q %q", src, dst)
	}
}

func TestFirewallLogSrcDST_kernelSnippet(t *testing.T) {
	line := "kernel: evuproxy-geo-block: IN=eth0 SRC=1.2.3.4 DST=5.6.7.8"
	src, dst := FirewallLogSrcDST(line)
	if src != "1.2.3.4" || dst != "5.6.7.8" {
		t.Fatalf("got %q %q", src, dst)
	}
}

func TestFirewallLogSrcDST_journalLine(t *testing.T) {
	line := "2026-01-15T10:00:02+00:00 host kernel: evuproxy-forward-drop: SRC=10.0.0.1 DST=10.0.0.2"
	src, dst := FirewallLogSrcDST(line)
	if src != "10.0.0.1" || dst != "10.0.0.2" {
		t.Fatalf("got %q %q", src, dst)
	}
}
