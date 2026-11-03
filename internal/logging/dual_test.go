package logging

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSIGHUPReopensRenamedLog(t *testing.T) {
	prev := slog.Default()
	t.Cleanup(func() { slog.SetDefault(prev) })

	dir := t.TempDir()
	cleanup, err := SetupFileAndStderr(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)

	path := filepath.Join(dir, "evuproxy.jsonl")
	rotated := path + ".1"
	slog.Info("before-rotate")
	if err := os.Rename(path, rotated); err != nil {
		t.Fatal(err)
	}
	slog.Info("after-rename")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("log recreated before SIGHUP: %v", err)
	}

	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(path); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("log not recreated after SIGHUP")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// The reopen swaps the writer just after creating the file, so wait for its own log line.
	for !strings.Contains(readFile(t, path), "log file reopened") {
		if time.Now().After(deadline) {
			t.Fatal("reopen line not written to the new file")
		}
		time.Sleep(5 * time.Millisecond)
	}
	slog.Info("after-reopen")

	old := readFile(t, rotated)
	for _, want := range []string{"before-rotate", "after-rename"} {
		if !strings.Contains(old, want) {
			t.Errorf("rotated file missing %q:\n%s", want, old)
		}
	}
	if strings.Contains(old, "after-reopen") {
		t.Errorf("line written after reopen went to the rotated file:\n%s", old)
	}
	if cur := readFile(t, path); !strings.Contains(cur, "after-reopen") {
		t.Errorf("new file missing line written after reopen:\n%s", cur)
	}
}

func TestReopenFailureKeepsCurrentFile(t *testing.T) {
	parent := t.TempDir()
	dir := filepath.Join(parent, "logs")
	if err := os.Mkdir(dir, 0o750); err != nil {
		t.Fatal(err)
	}
	w, err := openReopenWriter(filepath.Join(dir, "evuproxy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })

	// Moving the directory makes the path unopenable, and works when tests run as root too.
	moved := filepath.Join(parent, "moved")
	if err := os.Rename(dir, moved); err != nil {
		t.Fatal(err)
	}
	if err := w.Reopen(); err == nil {
		t.Fatal("Reopen succeeded with the log directory gone")
	}
	if _, err := w.Write([]byte("kept\n")); err != nil {
		t.Fatalf("write after failed reopen: %v", err)
	}
	if got := readFile(t, filepath.Join(moved, "evuproxy.jsonl")); got != "kept\n" {
		t.Errorf("current file = %q", got)
	}
}

func TestConcurrentWritesDuringRotationKeepEveryLine(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "evuproxy.jsonl")
	w, err := openReopenWriter(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = w.Close() })
	log := slog.New(slog.NewJSONHandler(w, nil))

	const writers, perWriter, rotations = 8, 200, 20
	done := make(chan struct{})
	var rotateErr error
	go func() {
		defer close(done)
		for i := range rotations {
			if rotateErr = os.Rename(path, fmt.Sprintf("%s.%d", path, i)); rotateErr != nil {
				return
			}
			if rotateErr = w.Reopen(); rotateErr != nil {
				return
			}
		}
	}()
	var wg sync.WaitGroup
	for n := range writers {
		wg.Go(func() {
			for i := range perWriter {
				log.Info("line", "writer", n, "seq", i)
			}
		})
	}
	wg.Wait()
	<-done
	if rotateErr != nil {
		t.Fatal(rotateErr)
	}

	files, err := filepath.Glob(path + "*")
	if err != nil {
		t.Fatal(err)
	}
	seen := 0
	for _, f := range files {
		for line := range strings.Lines(readFile(t, f)) {
			if !json.Valid([]byte(line)) {
				t.Errorf("%s: torn line %q", f, line)
			}
			seen++
		}
	}
	if want := writers * perWriter; seen != want {
		t.Errorf("found %d lines across %d files, want %d", seen, len(files), want)
	}
}
