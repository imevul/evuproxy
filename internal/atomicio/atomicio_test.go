package atomicio

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteFile_createsWithContentAndMode(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.txt")
	if err := WriteFile(path, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "hello" {
		t.Fatalf("content %q", b)
	}
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
}

func TestWriteFile_replacesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "out.txt")
	if err := os.WriteFile(path, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteFile(path, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "new" {
		t.Fatalf("content %q", b)
	}
}

func TestWriteFile_leavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "out.txt")
	if err := WriteFile(path, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".evuproxy-") {
			t.Fatalf("leftover temp file %s", e.Name())
		}
	}
}

func TestWriteFile_missingDirFailsWithoutCreatingTarget(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nope", "out.txt")
	if err := WriteFile(path, []byte("x"), 0o644); err == nil {
		t.Fatal("want error for missing parent dir")
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("target should not exist, stat err %v", err)
	}
}

func TestWriteFile_originalIntactWhenTempCreationFails(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root; permission-based failure not enforceable")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, "out.txt")
	if err := os.WriteFile(path, []byte("original"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if err := WriteFile(path, []byte("clobber"), 0o644); err == nil {
		t.Fatal("want error when directory is read-only")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "original" {
		t.Fatalf("original clobbered: %q", b)
	}
}
