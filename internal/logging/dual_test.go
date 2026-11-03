package logging

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// isolateGlobals points os.Stderr at a file and restores the process-wide loggers
// that SetupFileAndStderr replaces. It returns a func reading what reached stderr.
func isolateGlobals(t *testing.T) func() string {
	t.Helper()
	prevDefault, prevWriter, prevFlags, prevStderr := slog.Default(), log.Writer(), log.Flags(), os.Stderr
	path := filepath.Join(t.TempDir(), "stderr")
	f, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = f
	t.Cleanup(func() {
		os.Stderr = prevStderr
		slog.SetDefault(prevDefault)
		log.SetOutput(prevWriter)
		log.SetFlags(prevFlags)
		_ = f.Close()
	})
	return func() string {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
}

func setup(t *testing.T, dir string) (cleanup func()) {
	t.Helper()
	cleanup, err := SetupFileAndStderr(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cleanup)
	return cleanup
}

func readJSONLines(t *testing.T, dir string) []map[string]any {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, "evuproxy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	var out []map[string]any
	for _, line := range strings.Split(strings.TrimSpace(string(b)), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("line %q is not JSON: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestSetupFileAndStderr_writesJSONFileAndTextStderr(t *testing.T) {
	stderr := isolateGlobals(t)
	dir := filepath.Join(t.TempDir(), "nested", "logs")
	setup(t, dir)

	slog.Info("peer added", "peer", "alice")

	lines := readJSONLines(t, dir)
	if len(lines) != 1 {
		t.Fatalf("got %d lines: %v", len(lines), lines)
	}
	if lines[0]["msg"] != "peer added" || lines[0]["peer"] != "alice" || lines[0]["level"] != "INFO" {
		t.Fatalf("json line: %v", lines[0])
	}
	got := stderr()
	if !strings.Contains(got, `msg="peer added"`) || !strings.Contains(got, "peer=alice") {
		t.Fatalf("stderr is not slog text: %q", got)
	}
}

func TestSetupFileAndStderr_restrictsPermissions(t *testing.T) {
	isolateGlobals(t)
	dir := filepath.Join(t.TempDir(), "logs")
	setup(t, dir)

	// Logs can name peers and client addresses, so other users must not read them.
	fi, err := os.Stat(filepath.Join(dir, "evuproxy.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Fatalf("file mode %o", perm)
	}
	di, err := os.Stat(dir)
	if err != nil {
		t.Fatal(err)
	}
	if perm := di.Mode().Perm(); perm&0o027 != 0 {
		t.Fatalf("dir mode %o", perm)
	}
}

func TestSetupFileAndStderr_appendsAcrossRestarts(t *testing.T) {
	isolateGlobals(t)
	dir := t.TempDir()

	first := setup(t, dir)
	slog.Info("first run")
	first()

	setup(t, dir)
	slog.Info("second run")

	lines := readJSONLines(t, dir)
	if len(lines) != 2 || lines[0]["msg"] != "first run" || lines[1]["msg"] != "second run" {
		t.Fatalf("lines: %v", lines)
	}
}

func TestSetupFileAndStderr_filtersBelowInfo(t *testing.T) {
	stderr := isolateGlobals(t)
	dir := t.TempDir()
	setup(t, dir)

	slog.Debug("too quiet")
	slog.Warn("loud enough")

	lines := readJSONLines(t, dir)
	if len(lines) != 1 || lines[0]["msg"] != "loud enough" {
		t.Fatalf("lines: %v", lines)
	}
	got := stderr()
	if strings.Contains(got, "too quiet") || !strings.Contains(got, "loud enough") {
		t.Fatalf("stderr: %q", got)
	}
}

func TestSetupFileAndStderr_attrsAndGroupsReachBothOutputs(t *testing.T) {
	stderr := isolateGlobals(t)
	dir := t.TempDir()
	setup(t, dir)

	slog.With("component", "api").WithGroup("req").Info("handled", "status", 200)

	lines := readJSONLines(t, dir)
	if len(lines) != 1 || lines[0]["component"] != "api" {
		t.Fatalf("lines: %v", lines)
	}
	if req, ok := lines[0]["req"].(map[string]any); !ok || req["status"] != float64(200) {
		t.Fatalf("group missing from json: %v", lines[0])
	}
	got := stderr()
	if !strings.Contains(got, "component=api") || !strings.Contains(got, "req.status=200") {
		t.Fatalf("stderr: %q", got)
	}
}

func TestSetupFileAndStderr_capturesStandardLogPackage(t *testing.T) {
	isolateGlobals(t)
	dir := t.TempDir()
	setup(t, dir)

	// net/http reports server errors through the log package.
	log.Print("http: TLS handshake error")

	lines := readJSONLines(t, dir)
	if len(lines) != 1 || lines[0]["msg"] != "http: TLS handshake error" {
		t.Fatalf("lines: %v", lines)
	}
}

func TestSetupFileAndStderr_afterCleanupStderrKeepsWorking(t *testing.T) {
	stderr := isolateGlobals(t)
	dir := t.TempDir()
	setup(t, dir)()

	slog.Info("late message")

	if got := stderr(); !strings.Contains(got, "late message") {
		t.Fatalf("stderr: %q", got)
	}
	if lines := readJSONLines(t, dir); len(lines) != 0 {
		t.Fatalf("lines: %v", lines)
	}
}

func TestSetupFileAndStderr_errorsLeaveDefaultLogger(t *testing.T) {
	tests := []struct {
		name string
		dir  func(t *testing.T) string
	}{
		{"log dir path is a file", func(t *testing.T) string {
			p := filepath.Join(t.TempDir(), "file")
			if err := os.WriteFile(p, nil, 0o600); err != nil {
				t.Fatal(err)
			}
			return p
		}},
		{"log file path is a directory", func(t *testing.T) string {
			d := t.TempDir()
			if err := os.Mkdir(filepath.Join(d, "evuproxy.jsonl"), 0o700); err != nil {
				t.Fatal(err)
			}
			return d
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			isolateGlobals(t)
			before := slog.Default()
			cleanup, err := SetupFileAndStderr(tc.dir(t))
			if err == nil {
				cleanup()
				t.Fatal("expected error")
			}
			if cleanup != nil {
				t.Fatal("expected nil cleanup on error")
			}
			if slog.Default() != before {
				t.Fatal("default logger replaced on failure")
			}
		})
	}
}

type fakeHandler struct {
	level   slog.Level
	err     error
	handled []string
}

func (f *fakeHandler) Enabled(_ context.Context, l slog.Level) bool { return l >= f.level }

func (f *fakeHandler) Handle(_ context.Context, r slog.Record) error {
	f.handled = append(f.handled, r.Message)
	return f.err
}

func (f *fakeHandler) WithAttrs([]slog.Attr) slog.Handler { return f }
func (f *fakeHandler) WithGroup(string) slog.Handler      { return f }

func TestDualHandler_Handle(t *testing.T) {
	jsonErr, textErr := errors.New("json failed"), errors.New("text failed")
	tests := []struct {
		name    string
		jsonErr error
		textErr error
		want    error
	}{
		{"both succeed", nil, nil, nil},
		{"text failure does not stop the file or fail the call", nil, textErr, nil},
		{"file failure is reported after stderr is written", jsonErr, nil, jsonErr},
		{"file failure wins when both fail", jsonErr, textErr, jsonErr},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			j, x := &fakeHandler{err: tc.jsonErr}, &fakeHandler{err: tc.textErr}
			d := &dualHandler{json: j, text: x}
			err := d.Handle(context.Background(), slog.NewRecord(time.Now(), slog.LevelInfo, "m", 0))
			if !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if len(j.handled) != 1 || len(x.handled) != 1 {
				t.Fatalf("json handled %v, text handled %v", j.handled, x.handled)
			}
		})
	}
}

func TestDualHandler_EnabledWhenEitherOutputWants(t *testing.T) {
	d := &dualHandler{
		json: &fakeHandler{level: slog.LevelError},
		text: &fakeHandler{level: slog.LevelInfo},
	}
	ctx := context.Background()
	if d.Enabled(ctx, slog.LevelDebug) {
		t.Fatal("debug should be off for both")
	}
	if !d.Enabled(ctx, slog.LevelInfo) {
		t.Fatal("info should be on for text")
	}
	flipped := &dualHandler{json: d.text, text: d.json}
	if !flipped.Enabled(ctx, slog.LevelInfo) {
		t.Fatal("info should be on for json")
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSIGHUPReopensRenamedLog(t *testing.T) {
	isolateGlobals(t)
	dir := t.TempDir()
	setup(t, dir)

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
