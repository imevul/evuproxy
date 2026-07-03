package apply

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
)

func TestRecordAppliedConfigSnapshot_seedsBak(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(b, []byte(testCfgV1)) {
		t.Fatalf("bak should match applied config")
	}
}

func TestRecordAppliedConfigSnapshot_noopWhenEqual(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(configYAMLBackupNth(cfgPath, 1)); !os.IsNotExist(err) {
		t.Fatal("expected no rotation when cur == bak")
	}
}

func TestRecordAppliedConfigSnapshot_rotates(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfgPath, []byte(testCfgV2), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RecordAppliedConfigSnapshot(cfgPath); err != nil {
		t.Fatal(err)
	}
	bak, err := os.ReadFile(ConfigYAMLBackupPath(cfgPath))
	if err != nil {
		t.Fatal(err)
	}
	if string(bak) != testCfgV2 {
		t.Fatalf(".bak should be v2")
	}
	b1, err := os.ReadFile(configYAMLBackupNth(cfgPath, 1))
	if err != nil {
		t.Fatal(err)
	}
	if string(b1) != testCfgV1 {
		t.Fatalf(".bak.1 should be previous .bak (v1)")
	}
}

func TestDiscardPendingConfigYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV2), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ConfigYAMLBackupPath(cfgPath), []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := DiscardPendingConfigYAML(cfgPath); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WireGuard.ListenPort != 51830 {
		t.Fatalf("expected v1 port, got %d", loaded.WireGuard.ListenPort)
	}
}

func TestDiscardPendingConfigYAML_rejectsNoDrift(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ConfigYAMLBackupPath(cfgPath), []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := DiscardPendingConfigYAML(cfgPath); err == nil {
		t.Fatal("expected error when no drift")
	}
}

func TestRestorePreviousAppliedConfigYAML_overwritesDrift(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	// History: bak=v2, bak.1=v1
	if err := os.WriteFile(ConfigYAMLBackupPath(cfgPath), []byte(testCfgV2), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(configYAMLBackupNth(cfgPath, 1), []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	// Drift: cur is different from both (simulate unsaved mess)
	if err := os.WriteFile(cfgPath, []byte(testCfgV2), 0o644); err != nil {
		t.Fatal(err)
	}
	// Actually for restore first differing from bak: bak is v2, bak.1 is v1, differs -> restore v1
	if err := RestorePreviousAppliedConfigYAML(cfgPath); err != nil {
		t.Fatal(err)
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.WireGuard.ListenPort != 51830 {
		t.Fatalf("expected restored v1, got %d", loaded.WireGuard.ListenPort)
	}
	bak, _ := os.ReadFile(ConfigYAMLBackupPath(cfgPath))
	if string(bak) != testCfgV2 {
		t.Fatalf(".bak should be unchanged")
	}
}

func TestRestorePreviousAppliedConfigYAML_noHistory(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ConfigYAMLBackupPath(cfgPath), []byte(testCfgV1), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := RestorePreviousAppliedConfigYAML(cfgPath); err == nil {
		t.Fatal("expected error when no differing .bak.N")
	}
}
