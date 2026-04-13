package apply

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"gopkg.in/yaml.v3"
)

func TestSaveConfigYAML_createsBackupOnReplace(t *testing.T) {
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
	bak := ConfigYAMLBackupPath(cfgPath)
	b, err := os.ReadFile(bak)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != testCfgV1 {
		t.Fatalf("backup mismatch")
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WireGuard.ListenPort != 51831 {
		t.Fatalf("config not updated, got port %d", loaded.WireGuard.ListenPort)
	}
}

func TestSaveConfigYAML_noBackupOnFirstWrite(t *testing.T) {
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

func TestUndoConfigYAML_swap(t *testing.T) {
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
	if err := UndoConfigYAML(cfgPath); err != nil {
		t.Fatal(err)
	}
	cur, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(cur) != testCfgV1 {
		t.Fatalf("undo did not restore v1")
	}
redo, err := config.Load(ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		t.Fatal(err)
	}
	if redo.WireGuard.ListenPort != 51831 {
		t.Fatalf("swap: expected v2 in backup, got port %d", redo.WireGuard.ListenPort)
	}
}

func TestUndoConfigYAML_noBackup(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := UndoConfigYAML(cfgPath); err == nil {
		t.Fatal("expected error")
	}
}
