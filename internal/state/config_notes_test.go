package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestConfigNotesRoundTrip(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfgPath, []byte("x: y\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	p := ConfigNotesPath(cfgPath)
	if filepath.Base(p) != ConfigNotesFile {
		t.Fatalf("path %s", p)
	}
	s := "line one\nline two"
	if err := SaveConfigNotes(cfgPath, s); err != nil {
		t.Fatal(err)
	}
	got, err := LoadConfigNotes(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	// SaveConfigNotes ensures trailing newline when non-empty.
	want := s + "\n"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}
