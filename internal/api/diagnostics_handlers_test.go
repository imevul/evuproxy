package api

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/imevul/evuproxy/internal/apply"
)

func TestDiagnosticsMD_okAndUnauthorized(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)

	restoreDir := apply.SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := apply.SwapNetworkdOrNetplanInUseForTest(func() bool { return false })
	defer restoreDet()
	restoreExists := apply.SwapWgInterfaceExistsForTest(func(string) bool { return false })
	defer restoreExists()
	restoreRunner := apply.SwapCommandRunnerForTest(&diagAPIStubRunner{})
	defer restoreRunner()

	s := &Server{
		Token:   "t",
		Config:  cfgPath,
		Listen:  "127.0.0.1:0",
		Version: "1.2.3-test",
	}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/diagnostics.md", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauth status %d", resp.StatusCode)
	}

	req, _ = http.NewRequest(http.MethodGet, ts.URL+"/api/v1/diagnostics.md", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d body %s", resp.StatusCode, b)
	}
	ct := resp.Header.Get("Content-Type")
	if !strings.Contains(ct, "text/markdown") {
		t.Fatalf("content-type %q", ct)
	}
	cd := resp.Header.Get("Content-Disposition")
	if !strings.Contains(cd, "attachment") || !strings.Contains(cd, "evuproxy-diagnostics-") {
		t.Fatalf("disposition %q", cd)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	sbody := string(body)
	if !strings.Contains(sbody, "evuproxy_version: \"1.2.3-test\"") {
		t.Fatalf("missing version in body")
	}
	if !strings.Contains(sbody, "# EvuProxy host diagnostics") {
		t.Fatal("missing title")
	}
}

func TestDiagnosticsMD_rateLimit(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	restoreRunner := apply.SwapCommandRunnerForTest(&diagAPIStubRunner{})
	defer restoreRunner()
	restoreDir := apply.SwapSystemdNetworkDirForTest(dir)
	defer restoreDir()
	restoreDet := apply.SwapNetworkdOrNetplanInUseForTest(func() bool { return false })
	defer restoreDet()
	restoreExists := apply.SwapWgInterfaceExistsForTest(func(string) bool { return false })
	defer restoreExists()

	s := &Server{Token: "t", Config: cfgPath, Listen: "127.0.0.1:0", Version: "v"}
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)

	for i := 0; i < 10; i++ {
		req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/diagnostics.md", nil)
		req.Header.Set("Authorization", "Bearer t")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("iter %d status %d", i, resp.StatusCode)
		}
	}
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/v1/diagnostics.md", nil)
	req.Header.Set("Authorization", "Bearer t")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("status %d want 429", resp.StatusCode)
	}
}

type diagAPIStubRunner struct{}

func (diagAPIStubRunner) CombinedOutput(ctx context.Context, name string, args ...string) ([]byte, error) {
	return []byte("ok\n"), nil
}

func (diagAPIStubRunner) Output(ctx context.Context, name string, args ...string) ([]byte, error) {
	return []byte("ok\n"), nil
}

func (diagAPIStubRunner) OutputWithStdin(ctx context.Context, stdin, name string, args ...string) ([]byte, error) {
	return []byte("ok\n"), nil
}
