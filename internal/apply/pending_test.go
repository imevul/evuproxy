package apply

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/state"
)

func TestPendingSummaryAppliedConfig(t *testing.T) {
	setup := func(t *testing.T) string {
		t.Helper()
		cfgPath := filepath.Join(t.TempDir(), "evuproxy.yaml")
		if err := os.WriteFile(cfgPath, []byte(testCfgV1), 0o644); err != nil {
			t.Fatal(err)
		}
		return cfgPath
	}
	// Records V1 as applied with a matching .bak, then saves V2 on top.
	applyThenEdit := func(t *testing.T, cfgPath string) {
		t.Helper()
		if err := state.RecordAppliedConfigHash(cfgPath); err != nil {
			t.Fatal(err)
		}
		if err := state.RecordAppliedConfigSnapshot(cfgPath); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(cfgPath, []byte(testCfgV2), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	appliedConfig := func(t *testing.T, cfgPath string) *config.Config {
		t.Helper()
		info, err := PendingSummary(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		return info.AppliedConfig
	}

	t.Run("returns the applied config, not the saved one", func(t *testing.T) {
		cfgPath := setup(t)
		applyThenEdit(t, cfgPath)
		want, err := config.Load(state.ConfigYAMLBackupPath(cfgPath))
		if err != nil {
			t.Fatal(err)
		}
		saved, err := config.Load(cfgPath)
		if err != nil {
			t.Fatal(err)
		}
		if reflect.DeepEqual(want, saved) {
			t.Fatal("test configs must differ")
		}
		if got := appliedConfig(t, cfgPath); !reflect.DeepEqual(got, want) {
			t.Fatalf("applied config = %+v, want %+v", got, want)
		}
	})

	t.Run("null without a snapshot", func(t *testing.T) {
		cfgPath := setup(t)
		if err := state.EnsureApplyStateFromDisk(cfgPath); err != nil {
			t.Fatal(err)
		}
		if got := appliedConfig(t, cfgPath); got != nil {
			t.Fatalf("expected nil, got %+v", got)
		}
	})

	t.Run("null when the snapshot is not what was last applied", func(t *testing.T) {
		cfgPath := setup(t)
		applyThenEdit(t, cfgPath)
		// A reload that recorded the hash but failed to write .bak.
		if err := state.RecordAppliedConfigHash(cfgPath); err != nil {
			t.Fatal(err)
		}
		if got := appliedConfig(t, cfgPath); got != nil {
			t.Fatalf("expected nil, got %+v", got)
		}
	})

	t.Run("null when nothing was recorded as applied", func(t *testing.T) {
		cfgPath := setup(t)
		if err := state.RecordAppliedConfigSnapshot(cfgPath); err != nil {
			t.Fatal(err)
		}
		if got := appliedConfig(t, cfgPath); got != nil {
			t.Fatalf("expected nil, got %+v", got)
		}
	})

	t.Run("null when the snapshot no longer loads", func(t *testing.T) {
		cfgPath := setup(t)
		applyThenEdit(t, cfgPath)
		bad := []byte("wireguard: [not, a, mapping]\n")
		if err := os.WriteFile(state.ConfigYAMLBackupPath(cfgPath), bad, 0o644); err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(bad)
		if err := state.WriteAppliedConfigHash(cfgPath, hex.EncodeToString(h[:])); err != nil {
			t.Fatal(err)
		}
		if got := appliedConfig(t, cfgPath); got != nil {
			t.Fatalf("expected nil, got %+v", got)
		}
	})
}
