package apply

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
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
	if _, err := os.Stat(state.ConfigYAMLBackupPath(cfgPath)); !os.IsNotExist(err) {
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
	if _, err := os.Stat(state.ConfigYAMLBackupPath(cfgPath)); !os.IsNotExist(err) {
		t.Fatalf("expected no backup on first write")
	}
}

func TestSaveConfigYAML_wrapsPlainValidateErrors(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	c := config.Config{
		WireGuard: config.WireGuard{
			Interface:      "wg0",
			ListenPort:     51820,
			PrivateKeyFile: "/key",
			Address:        "10.100.0.1/24",
		},
		// Missing network.public_interface → plain Validate error, must become ValidationError.
	}
	err := SaveConfigYAML(cfgPath, &c)
	if err == nil {
		t.Fatal("expected validation error")
	}
	var ve *config.ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("want ValidationError wrap, got %T %v", err, err)
	}
	if ve.Code != "config_invalid" {
		t.Fatalf("code %q", ve.Code)
	}
	if _, err := os.Stat(cfgPath); !os.IsNotExist(err) {
		t.Fatal("invalid config must not be written")
	}
}
