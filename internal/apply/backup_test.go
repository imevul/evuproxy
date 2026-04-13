package apply

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreSafe_extractsFile(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", dir)
	root := filepath.Join(dir, "cfgroot")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := filepath.Join(root, "config.yaml")
	if err := os.WriteFile(cfg, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	// Archive must live outside the tree being packed (tar reads ".").
	arch := filepath.Join(dir, "b.tgz")
	if err := Backup(cfg, arch); err != nil {
		t.Fatal(err)
	}
	sub := filepath.Join(dir, "restore-here")
	if err := os.MkdirAll(sub, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg2 := filepath.Join(sub, "config.yaml")
	if err := os.WriteFile(cfg2, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Restore(cfg2, arch); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(cfg2)
	if err != nil {
		t.Fatal(err)
	}
	if string(b) != "x" {
		t.Fatalf("got %q want restored content from archive", b)
	}
}

func TestRestore_rejectsTraversal(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", dir)
	cfg := filepath.Join(dir, "nested", "config.yaml")
	if err := os.MkdirAll(filepath.Dir(cfg), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(cfg, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	_ = tw.WriteHeader(&tar.Header{Name: "../evil", Mode: 0o644, Size: 3, Typeflag: tar.TypeReg})
	_, _ = tw.Write([]byte("bad"))
	_ = tw.Close()
	_ = gw.Close()

	arch := filepath.Join(dir, "bad.tgz")
	if err := os.WriteFile(arch, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Restore(cfg, arch); err == nil {
		t.Fatal("expected error for path traversal")
	}
}

func TestResolveBackupPath_allowlist(t *testing.T) {
	dir := t.TempDir()
	allow := filepath.Join(dir, "backups")
	if err := os.MkdirAll(allow, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("EVUPROXY_BACKUP_DIR", allow)

	got, err := ResolveBackupPath(filepath.Join(allow, "x.tgz"))
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Clean(got) != filepath.Clean(filepath.Join(allow, "x.tgz")) {
		t.Fatalf("got %q", got)
	}

	if _, err := ResolveBackupPath("/etc/passwd"); err == nil {
		t.Fatal("expected reject outside allow dir")
	}
	if _, err := ResolveBackupPath("relative.tgz"); err == nil {
		t.Fatal("expected reject relative path")
	}
}

func TestRestore_rejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("EVUPROXY_BACKUP_DIR", dir)
	cfg := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(cfg, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gw)
	_ = tw.WriteHeader(&tar.Header{Name: "link", Mode: 0o777, Size: 0, Typeflag: tar.TypeSymlink, Linkname: "/etc/passwd"})
	_ = tw.Close()
	_ = gw.Close()
	arch := filepath.Join(dir, "sym.tgz")
	if err := os.WriteFile(arch, buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Restore(cfg, arch); err == nil {
		t.Fatal("expected error for symlink")
	}
}
