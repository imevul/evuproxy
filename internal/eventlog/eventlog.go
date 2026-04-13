package eventlog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/imevul/evuproxy/internal/atomicio"
)

const (
	// DefaultMaxBytes is the default cap for events.jsonl on disk.
	DefaultMaxBytes = 2 * 1024 * 1024
	minMaxBytes     = 256 * 1024
	maxMaxBytes     = 8 * 1024 * 1024
)

// MaxBytesFromEnv returns EVUPROXY_EVENTS_MAX_BYTES parsed and clamped to [256KiB, 8MiB], or default when unset/invalid.
func MaxBytesFromEnv() int {
	s := strings.TrimSpace(os.Getenv("EVUPROXY_EVENTS_MAX_BYTES"))
	if s == "" {
		return DefaultMaxBytes
	}
	n, err := strconv.Atoi(s)
	if err != nil || n <= 0 {
		return DefaultMaxBytes
	}
	if n < minMaxBytes {
		n = minMaxBytes
	}
	if n > maxMaxBytes {
		n = maxMaxBytes
	}
	return n
}

// Record is one JSON line in events.jsonl.
type Record struct {
	Event      string    `json:"event"`
	Detail     string    `json:"detail,omitempty"`
	HTTPStatus int       `json:"http_status,omitempty"`
	ErrorCode  string    `json:"error_code,omitempty"`
	Ts         time.Time `json:"-"`
}

type recordJSON struct {
	Ts         string `json:"ts"`
	Event      string `json:"event"`
	Detail     string `json:"detail,omitempty"`
	HTTPStatus int    `json:"http_status,omitempty"`
	ErrorCode  string `json:"error_code,omitempty"`
}

func (r Record) lineBytes() ([]byte, error) {
	ts := r.Ts
	if ts.IsZero() {
		ts = time.Now().UTC()
	}
	j, err := json.Marshal(recordJSON{
		Ts:         ts.UTC().Format(time.RFC3339),
		Event:      r.Event,
		Detail:     r.Detail,
		HTTPStatus: r.HTTPStatus,
		ErrorCode:  r.ErrorCode,
	})
	if err != nil {
		return nil, err
	}
	return append(j, '\n'), nil
}

// Logger appends JSONL audit events with a hard size cap.
type Logger struct {
	mu       sync.Mutex
	path     string
	maxBytes int
}

// New creates a logger writing to configDir/state/events.jsonl.
func New(configDir string, maxBytes int) (*Logger, error) {
	st := filepath.Join(configDir, "state")
	if err := os.MkdirAll(st, 0o750); err != nil {
		return nil, err
	}
	p := filepath.Join(st, "events.jsonl")
	if maxBytes < minMaxBytes {
		maxBytes = minMaxBytes
	}
	if maxBytes > maxMaxBytes {
		maxBytes = maxMaxBytes
	}
	return &Logger{path: p, maxBytes: maxBytes}, nil
}

// Append adds one event line; compacts the file if needed so size stays ≤ maxBytes.
func (l *Logger) Append(r Record) error {
	line, err := r.lineBytes()
	if err != nil {
		return err
	}
	if len(line) > l.maxBytes {
		return fmt.Errorf("event line exceeds max bytes")
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if err := l.appendAfterCompact(line); err != nil {
		return err
	}
	st, err := os.Stat(l.path)
	if err != nil {
		return err
	}
	if int(st.Size()) > l.maxBytes {
		return errors.New("events file over cap after append (unexpected)")
	}
	return nil
}

func (l *Logger) appendAfterCompact(line []byte) error {
	for tries := 0; tries < 3; tries++ {
		st, err := os.Stat(l.path)
		cur := int64(0)
		if err == nil {
			cur = st.Size()
		} else if !os.IsNotExist(err) {
			return err
		}
		if int(cur)+len(line) <= l.maxBytes {
			return l.appendLine(line)
		}
		if cur == 0 {
			return l.appendLine(line)
		}
		if err := l.compactLocked(); err != nil {
			return fmt.Errorf("events compaction: %w", err)
		}
	}
	return errors.New("events compaction failed after retries")
}

func (l *Logger) appendLine(line []byte) error {
	f, err := os.OpenFile(l.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.Write(line)
	return err
}

func (l *Logger) compactLocked() error {
	b, err := os.ReadFile(l.path)
	if err != nil {
		return err
	}
	lines := bytes.Split(b, []byte("\n"))
	var nonempty [][]byte
	for _, ln := range lines {
		if len(bytes.TrimSpace(ln)) == 0 {
			continue
		}
		nonempty = append(nonempty, ln)
	}
	target := l.maxBytes * 80 / 100
	if target < 1024 {
		target = 1024
	}
	var kept [][]byte
	total := 0
	for i := len(nonempty) - 1; i >= 0; i-- {
		ln := nonempty[i]
		add := len(ln) + 1
		if total+add > target && len(kept) > 0 {
			break
		}
		kept = append(kept, ln)
		total += add
	}
	// reverse kept to chronological order (oldest first in file)
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	build := func() []byte {
		if len(kept) == 0 {
			return nil
		}
		body := bytes.Join(kept, []byte("\n"))
		return append(body, '\n')
	}
	body := build()
	for len(body) > l.maxBytes && len(kept) > 1 {
		kept = kept[1:]
		body = build()
	}
	if len(body) > l.maxBytes {
		body = nil
	}
	return atomicio.WriteFile(l.path, body, 0o600)
}

// ReadTail returns up to limit events, newest first.
func (l *Logger) ReadTail(limit int) ([]Record, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	f, err := os.Open(l.path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, err
	}
	size := st.Size()
	readSize := int64(l.maxBytes)
	if size < readSize {
		readSize = size
	}
	if readSize <= 0 {
		return nil, nil
	}
	start := size - readSize
	_, err = f.Seek(start, io.SeekStart)
	if err != nil {
		return nil, err
	}
	buf := make([]byte, readSize)
	_, err = io.ReadFull(f, buf)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		return nil, err
	}
	// Drop partial first line if we started mid-file
	if start > 0 {
		if idx := bytes.IndexByte(buf, '\n'); idx >= 0 {
			buf = buf[idx+1:]
		}
	}
	lines := bytes.Split(buf, []byte("\n"))
	var recs []Record
	for _, ln := range lines {
		ln = bytes.TrimSpace(ln)
		if len(ln) == 0 {
			continue
		}
		var j recordJSON
		if json.Unmarshal(ln, &j) != nil {
			continue
		}
		ts, _ := time.Parse(time.RFC3339, j.Ts)
		recs = append(recs, Record{
			Event:      j.Event,
			Detail:     j.Detail,
			HTTPStatus: j.HTTPStatus,
			ErrorCode:  j.ErrorCode,
			Ts:         ts,
		})
	}
	sort.Slice(recs, func(i, j int) bool { return recs[i].Ts.After(recs[j].Ts) })
	if len(recs) > limit {
		recs = recs[:limit]
	}
	return recs, nil
}
