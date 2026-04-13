package apply

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
)

// BackupAllowDir returns the directory prefix allowed for API backup/restore paths.
// Override with environment variable EVUPROXY_BACKUP_DIR (must be absolute after clean).
func BackupAllowDir() string {
	d := strings.TrimSpace(os.Getenv("EVUPROXY_BACKUP_DIR"))
	if d == "" {
		return "/var/backups"
	}
	return d
}

// ResolveBackupPath checks that p is an absolute path under BackupAllowDir after canonical
// resolution (no .. escape; symlinks on existing paths must not leave the allow tree).
func ResolveBackupPath(p string) (string, error) {
	if strings.TrimSpace(p) == "" {
		return "", fmt.Errorf("empty path")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("path must be absolute")
	}
	clean := filepath.Clean(p)
	root := filepath.Clean(BackupAllowDir())
	if !filepath.IsAbs(root) {
		return "", fmt.Errorf("EVUPROXY_BACKUP_DIR must be absolute")
	}
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	rootReal := rootAbs
	if r, err := filepath.EvalSymlinks(rootAbs); err == nil {
		rootReal = r
	}
	targetAbs, err := filepath.Abs(clean)
	if err != nil {
		return "", err
	}
	targetReal := targetAbs
	if r, err := filepath.EvalSymlinks(targetAbs); err == nil {
		targetReal = r
	} else {
		// Destination may not exist yet (backup output). Resolve parent chain.
		dir := filepath.Dir(targetAbs)
		if r, err := filepath.EvalSymlinks(dir); err == nil {
			targetReal = filepath.Join(r, filepath.Base(targetAbs))
		}
	}
	rel, err := filepath.Rel(rootReal, targetReal)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return "", fmt.Errorf("path outside %s", rootReal)
	}
	return targetAbs, nil
}

// Backup creates a gzip tarball of /etc/evuproxy (parent of config file).
func Backup(configPath, dest string) error {
	destAbs, err := filepath.Abs(dest)
	if err != nil {
		return fmt.Errorf("backup: dest: %w", err)
	}
	destResolved, err := ResolveBackupPath(destAbs)
	if err != nil {
		return fmt.Errorf("backup: %w", err)
	}
	root := filepath.Dir(configPath)
	if d := filepath.Dir(destResolved); d != "." && d != "/" {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("backup: mkdir: %w", err)
		}
	}
	cmd := exec.Command("tar", "-czf", destResolved, "-C", root, ".")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("tar: %w: %s", err, out)
	}
	return nil
}

// Restore extracts a gzip tarball into the config directory (parent of configPath).
// Only regular files and directories are allowed; symlinks, hard links, and absolute
// or parent-directory paths are rejected to avoid tar path traversal.
func Restore(configPath, archive string) error {
	archAbs, err := filepath.Abs(archive)
	if err != nil {
		return fmt.Errorf("restore: archive path: %w", err)
	}
	archivePath, err := ResolveBackupPath(archAbs)
	if err != nil {
		return fmt.Errorf("restore: %w", err)
	}
	root := filepath.Dir(configPath)
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return fmt.Errorf("restore: config root: %w", err)
	}
	f, err := os.Open(archivePath)
	if err != nil {
		return fmt.Errorf("restore: open archive: %w", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("restore: gzip: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		hdr, rel, err := nextTarMemberHeader(tr)
		if err == io.EOF {
			break
		}
		if err != nil {
			return err
		}
		if rel == "." {
			continue
		}
		target := filepath.Join(absRoot, rel)
		cleanTarget, err := filepath.Abs(target)
		if err != nil {
			return fmt.Errorf("restore: %w", err)
		}
		if cleanTarget != absRoot && !strings.HasPrefix(cleanTarget, absRoot+string(os.PathSeparator)) {
			return fmt.Errorf("restore: path escapes config directory")
		}
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(cleanTarget, dirMode(hdr)); err != nil {
				return fmt.Errorf("restore: mkdir: %w", err)
			}
		case tar.TypeReg, tar.TypeRegA:
			if err := os.MkdirAll(filepath.Dir(cleanTarget), 0o755); err != nil {
				return fmt.Errorf("restore: mkdir parent: %w", err)
			}
			if err := writeExtractedFile(cleanTarget, tr, hdr); err != nil {
				return err
			}
		default:
			return fmt.Errorf("restore: unsupported tar entry type %d for %q", hdr.Typeflag, hdr.Name)
		}
	}
	return nil
}

// nextTarMemberHeader reads the next archive member and validates hdr.Name before any
// extraction, mitigating zip-slip / path traversal from malicious archives.
func nextTarMemberHeader(tr *tar.Reader) (*tar.Header, string, error) {
	hdr, err := tr.Next()
	if err != nil {
		if err == io.EOF {
			return nil, "", io.EOF
		}
		return nil, "", fmt.Errorf("restore: read tar: %w", err)
	}
	rel, err := tarEntryRelPath(hdr.Name)
	if err != nil {
		return nil, "", fmt.Errorf("restore: %w", err)
	}
	return hdr, rel, nil
}

func dirMode(hdr *tar.Header) os.FileMode {
	m := os.FileMode(hdr.Mode) & 0o7777
	if m == 0 {
		return 0o755
	}
	return m
}

func writeExtractedFile(path string, tr *tar.Reader, hdr *tar.Header) error {
	const maxFile = 256 << 20 // 256 MiB per file
	if hdr.Size > maxFile {
		return fmt.Errorf("restore: file %q too large", hdr.Name)
	}
	if hdr.Size < 0 {
		return fmt.Errorf("restore: invalid size for %q", hdr.Name)
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".evuproxy-restore-*")
	if err != nil {
		return fmt.Errorf("restore: temp file: %w", err)
	}
	tmpPath := tmp.Name()
	ok := false
	defer func() {
		tmp.Close()
		if !ok {
			os.Remove(tmpPath)
		}
	}()
	if _, err := io.CopyN(tmp, tr, hdr.Size); err != nil {
		return fmt.Errorf("restore: write %q: %w", hdr.Name, err)
	}
	if err := tmp.Chmod(fileMode(hdr)); err != nil {
		return fmt.Errorf("restore: chmod: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("restore: close temp: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		return fmt.Errorf("restore: rename to %q: %w", path, err)
	}
	ok = true
	return nil
}

func fileMode(hdr *tar.Header) os.FileMode {
	m := os.FileMode(hdr.Mode) & 0o7777
	if m == 0 {
		return 0o644
	}
	return m
}

func tarEntryRelPath(name string) (string, error) {
	name = filepath.ToSlash(strings.TrimSpace(name))
	for strings.HasPrefix(name, "./") {
		name = name[2:]
	}
	name = strings.TrimPrefix(name, "/")
	if name == "" || name == "." {
		return ".", nil
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." {
			continue
		}
		if part == ".." {
			return "", fmt.Errorf("invalid path %q in archive", name)
		}
	}
	clean := path.Clean(name)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("invalid path %q in archive", name)
	}
	return filepath.FromSlash(clean), nil
}
