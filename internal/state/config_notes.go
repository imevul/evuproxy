package state

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	// ConfigNotesFile is stored next to config.yaml (operator annotations; not WireGuard YAML).
	ConfigNotesFile = "config-notes.txt"
	configNotesMax  = 256 << 10
)

// ConfigNotesPath returns the absolute path to the notes file for the given config path.
func ConfigNotesPath(cfgPath string) string {
	return filepath.Join(filepath.Dir(cfgPath), ConfigNotesFile)
}

// LoadConfigNotes reads operator notes; missing file returns empty string.
func LoadConfigNotes(cfgPath string) (string, error) {
	p := ConfigNotesPath(cfgPath)
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	return string(b), nil
}

// SaveConfigNotes writes notes atomically. Text must be at most configNotesMax runes (bytes for ASCII).
func SaveConfigNotes(cfgPath string, text string) error {
	if len(text) > configNotesMax {
		return fmt.Errorf("notes exceed max size %d bytes: %w", configNotesMax, ErrNotesTooLarge)
	}
	dir := filepath.Dir(cfgPath)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	p := ConfigNotesPath(cfgPath)
	trim := strings.TrimSuffix(text, "\n")
	data := []byte(trim)
	if len(data) > 0 {
		data = append(data, '\n')
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

// ErrNotesTooLarge indicates PUT body exceeded the limit.
var ErrNotesTooLarge = errors.New("notes too large")
