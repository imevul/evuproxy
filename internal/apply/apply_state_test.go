package apply

import (
	"os"
	"path/filepath"
	"testing"
)

const testCfgV1 = `wireguard:
  interface: evu0
  listen_port: 51830
  private_key_file: /etc/k
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes:
    - proto: tcp
      ports: ["80"]
      target_ip: 10.100.0.2
geo:
  enabled: false
  set_name: geo_v4
  countries: []
  zone_dir: /tmp/z
input_allows: []
peers:
  - name: p1
    public_key: aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=
    tunnel_ip: 10.100.0.2/32
`

const testCfgV2 = `wireguard:
  interface: evu0
  listen_port: 51831
  private_key_file: /etc/k
  address: 10.100.0.1/24
network:
  public_interface: eth0
forwarding:
  routes:
    - proto: tcp
      ports: ["80"]
      target_ip: 10.100.0.2
geo:
  enabled: false
  set_name: geo_v4
  countries: []
  zone_dir: /tmp/z
input_allows: []
peers:
  - name: p1
    public_key: aN1ZvFJyNFsFtXZjMKtQRGQB+YWY6NxcCX79QbRhP0k=
    tunnel_ip: 10.100.0.2/32
`

func TestApplyStatePendingAfterSave(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := EnsureApplyStateFromDisk(cfgPath); err != nil {
		t.Fatal(err)
	}
	info1, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if info1.Pending {
		t.Fatalf("unexpected pending after bootstrap: %+v", info1)
	}
	if err := os.WriteFile(cfgPath, []byte(testCfgV2), 0o644); err != nil {
		t.Fatal(err)
	}
	info2, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if !info2.Pending {
		t.Fatalf("expected pending after config change: %+v", info2)
	}
	if err := RecordAppliedConfigHash(cfgPath); err != nil {
		t.Fatal(err)
	}
	info3, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if info3.Pending {
		t.Fatalf("unexpected pending after record: %+v", info3)
	}
}

func TestPendingSummaryNFTablesBaseline(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	genDir := filepath.Join(dir, GeneratedDir)
	if err := os.MkdirAll(genDir, 0o755); err != nil {
		t.Fatal(err)
	}
	baseline := "# baseline nft\nflush ruleset\n"
	nftPath := filepath.Join(genDir, "nftables.nft")
	if err := os.WriteFile(nftPath, []byte(baseline), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.NFTablesBaseline != baseline {
		t.Fatalf("baseline: got %q want %q", info.NFTablesBaseline, baseline)
	}
	if info.NFTables == "" {
		t.Fatal("expected non-empty generated nftables from config")
	}
}

func TestPendingSummaryNFTablesBaselineMissing(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "evuproxy.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	info, err := PendingSummary(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.NFTablesBaseline != "" {
		t.Fatalf("expected empty baseline without generated/nftables.nft, got len %d", len(info.NFTablesBaseline))
	}
}
