package logging

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
)

// SetupFileAndStderr configures slog.Default() to write JSON lines to logDir/evuproxy.jsonl
// and human-readable text to stderr. logDir must be non-empty. SIGHUP reopens the file, so
// logrotate can rename it and signal the process; cleanup stops handling the signal.
func SetupFileAndStderr(logDir string) (cleanup func(), err error) {
	if err := os.MkdirAll(logDir, 0o750); err != nil {
		return nil, err
	}
	path := filepath.Join(logDir, "evuproxy.jsonl")
	w, err := openReopenWriter(path)
	if err != nil {
		return nil, err
	}
	jh := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo})
	eh := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(&dualHandler{json: jh, text: eh}))

	hup := make(chan os.Signal, 1)
	signal.Notify(hup, syscall.SIGHUP)
	stop := make(chan struct{})
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		for {
			select {
			case <-hup:
				if err := w.Reopen(); err != nil {
					slog.Error("log file reopen failed; still writing to the previous file", "path", path, "err", err)
				} else {
					slog.Info("log file reopened", "path", path)
				}
			case <-stop:
				return
			}
		}
	}()
	return func() {
		signal.Stop(hup)
		close(stop)
		<-stopped
		_ = w.Close()
	}, nil
}

// reopenWriter appends to the file at path and can switch to a fresh file at the same path.
type reopenWriter struct {
	path string
	mu   sync.Mutex
	f    *os.File
}

func openReopenWriter(path string) (*reopenWriter, error) {
	f, err := openLogFile(path)
	if err != nil {
		return nil, err
	}
	return &reopenWriter{path: path, f: f}, nil
}

func openLogFile(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
}

func (w *reopenWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Write(p)
}

// Reopen switches to the file now at path. On error the current file stays in use.
func (w *reopenWriter) Reopen() error {
	f, err := openLogFile(w.path)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	old := w.f
	w.f = f
	return old.Close()
}

func (w *reopenWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.f.Close()
}

type dualHandler struct {
	json slog.Handler
	text slog.Handler
}

func (d *dualHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return d.json.Enabled(ctx, level) || d.text.Enabled(ctx, level)
}

func (d *dualHandler) Handle(ctx context.Context, r slog.Record) error {
	_ = d.text.Handle(ctx, r)
	return d.json.Handle(ctx, r)
}

func (d *dualHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &dualHandler{json: d.json.WithAttrs(attrs), text: d.text.WithAttrs(attrs)}
}

func (d *dualHandler) WithGroup(name string) slog.Handler {
	return &dualHandler{json: d.json.WithGroup(name), text: d.text.WithGroup(name)}
}
