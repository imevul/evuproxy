package state

import (
	"path/filepath"
	"testing"
)

func TestRecordApplyMetrics_persisted(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := RecordApplySuccess(cfgPath); err != nil {
		t.Fatal(err)
	}
	if err := RecordApplySuccess(cfgPath); err != nil {
		t.Fatal(err)
	}
	if got := ApplySuccessTotal(cfgPath); got != 2 {
		t.Fatalf("success total = %d, want 2", got)
	}
	if err := RecordApplyFailure(cfgPath); err != nil {
		t.Fatal(err)
	}
	if got := ApplyFailureTotal(cfgPath); got != 1 {
		t.Fatalf("failure total = %d, want 1", got)
	}
}
