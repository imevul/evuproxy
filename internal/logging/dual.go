package logging

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
)

// SetupFileAndStderr configures slog.Default() to write JSON lines to logDir/evuproxy.jsonl
// and human-readable text to stderr. logDir must be non-empty.
func SetupFileAndStderr(logDir string) (cleanup func(), err error) {
	if err := os.MkdirAll(logDir, 0o750); err != nil {
		return nil, err
	}
	path := filepath.Join(logDir, "evuproxy.jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	jh := slog.NewJSONHandler(f, &slog.HandlerOptions{Level: slog.LevelInfo})
	eh := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo})
	slog.SetDefault(slog.New(&dualHandler{json: jh, text: eh}))
	return func() { _ = f.Close() }, nil
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
