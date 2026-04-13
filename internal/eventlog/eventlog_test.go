package eventlog

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoggerAppendAndReadTail(t *testing.T) {
	dir := t.TempDir()
	cfgDir := filepath.Join(dir, "etc", "evuproxy")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	l, err := New(cfgDir, minMaxBytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := l.Append(Record{Event: "test_one", Detail: "d1", Ts: time.Unix(100, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	if err := l.Append(Record{Event: "test_two", Detail: "d2", Ts: time.Unix(200, 0).UTC()}); err != nil {
		t.Fatal(err)
	}
	recs, err := l.ReadTail(10)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 2 {
		t.Fatalf("got %d records", len(recs))
	}
	if recs[0].Event != "test_two" || recs[1].Event != "test_one" {
		t.Fatalf("order: %#v", recs)
	}
}

func TestLoggerCompactionKeepsSizeNearCap(t *testing.T) {
	dir := t.TempDir()
	cfgDir := filepath.Join(dir, "etc", "evuproxy")
	if err := os.MkdirAll(cfgDir, 0o755); err != nil {
		t.Fatal(err)
	}
	maxB := minMaxBytes
	l, err := New(cfgDir, maxB)
	if err != nil {
		t.Fatal(err)
	}
	line := bytesForLine(400)
	for i := 0; i < 900; i++ {
		if err := l.Append(Record{Event: "fill", Detail: string(line), Ts: time.Now().UTC()}); err != nil {
			t.Fatalf("append %d: %v", i, err)
		}
	}
	st, err := os.Stat(filepath.Join(cfgDir, "state", "events.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if int(st.Size()) > maxB {
		t.Fatalf("file size %d over cap %d", st.Size(), maxB)
	}
	recs, err := l.ReadTail(5)
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) == 0 {
		t.Fatal("expected some events after compaction")
	}
}

func bytesForLine(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'a' + byte(i%26)
	}
	return b
}
