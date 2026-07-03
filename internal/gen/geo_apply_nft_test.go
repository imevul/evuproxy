package gen

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Verifies the reload-time combined apply file (table replace + geo loader in
// one batch) is accepted by nft -c as a single transaction.
func TestNFTables_combinedGeoApplyFile_nftCheck(t *testing.T) {
	if _, err := exec.LookPath("nft"); err != nil {
		t.Skip("nft not installed")
	}
	zoneDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(zoneDir, "se.zone"), []byte("192.0.2.0/24\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	c := baseNFTConfig()
	c.Geo.Enabled = true
	c.Geo.Mode = "allow"
	c.Geo.Countries = []string{"se"}
	c.Geo.ZoneDir = zoneDir
	c.Normalize()

	tbl, err := NFTables(c)
	if err != nil {
		t.Fatal(err)
	}
	loader, err := GeoLoaderNFT(c, zoneDir)
	if err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(t.TempDir(), "apply.nft")
	if err := os.WriteFile(p, []byte(tbl+"\n"+loader), 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("nft", "-c", "-f", p).CombinedOutput()
	if err != nil {
		// Same tolerance as nftCheck: sandboxes without netlink access still
		// exercise the parser; only syntax errors are hard failures.
		if strings.Contains(string(out), "syntax error") || !strings.Contains(string(out), "netlink") {
			t.Fatalf("nft -c rejected combined apply file: %v\n%s", err, out)
		}
	}
}
