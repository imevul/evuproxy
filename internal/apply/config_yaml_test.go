package apply

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"gopkg.in/yaml.v3"
)

func TestSaveConfigYAML_doesNotWriteBak(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	var c config.Config
	if err := yaml.Unmarshal([]byte(testCfgV2), &c); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfigYAML(cfgPath, &c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ConfigYAMLBackupPath(cfgPath)); !os.IsNotExist(err) {
		t.Fatal("SaveConfigYAML should not create .bak")
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WireGuard.ListenPort != 51831 {
		t.Fatalf("config not updated, got port %d", loaded.WireGuard.ListenPort)
	}
}

func TestSaveConfigYAML_firstWriteNoBak(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	var c config.Config
	if err := yaml.Unmarshal([]byte(testCfgV1), &c); err != nil {
		t.Fatal(err)
	}
	if err := SaveConfigYAML(cfgPath, &c); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(ConfigYAMLBackupPath(cfgPath)); !os.IsNotExist(err) {
		t.Fatalf("expected no backup on first write")
	}
}
