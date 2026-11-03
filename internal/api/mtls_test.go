package api

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type testCA struct {
	cert *x509.Certificate
	key  *ecdsa.PrivateKey
	pem  []byte
}

func newTestCA(t *testing.T, name string) *testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: name},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return &testCA{cert: cert, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

// issue returns PEM certificate and key signed by the CA.
func (ca *testCA) issue(t *testing.T, name string, usage x509.ExtKeyUsage, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	return ca.issueWithUsages(t, name, []x509.ExtKeyUsage{usage}, notAfter)
}

func (ca *testCA) issueWithUsages(t *testing.T, name string, usages []x509.ExtKeyUsage, notAfter time.Time) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: name},
		NotBefore:    time.Now().Add(-2 * time.Hour),
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  usages,
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, ca.cert, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

func writeTestFile(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

type mtlsFixture struct {
	ts       *httptest.Server
	clientCA *testCA
	serverCA *testCA
}

// newMTLSFixture serves the real routes with the TLS config mtlsConfig builds from files on disk.
func newMTLSFixture(t *testing.T) *mtlsFixture {
	t.Helper()
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	clientCA := newTestCA(t, "client ca")
	serverCA := newTestCA(t, "server ca")
	certPEM, keyPEM := serverCA.issue(t, "api", x509.ExtKeyUsageServerAuth, time.Now().Add(time.Hour))
	s := &Server{
		Token:            "secret-token",
		Config:           cfgPath,
		MTLSListen:       "127.0.0.1:0",
		MTLSCertFile:     writeTestFile(t, dir, "server.pem", certPEM),
		MTLSKeyFile:      writeTestFile(t, dir, "server.key", keyPEM),
		MTLSClientCAFile: writeTestFile(t, dir, "client-ca.pem", clientCA.pem),
	}
	cfg, err := s.mtlsConfig()
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewUnstartedServer(s.Routes())
	ts.TLS = cfg
	ts.StartTLS()
	t.Cleanup(ts.Close)
	return &mtlsFixture{ts: ts, clientCA: clientCA, serverCA: serverCA}
}

// client builds an HTTP client trusting the fixture's server CA, presenting the given PEM pair if any.
func (f *mtlsFixture) client(t *testing.T, certPEM, keyPEM []byte) *http.Client {
	t.Helper()
	roots := x509.NewCertPool()
	roots.AddCert(f.serverCA.cert)
	cfg := &tls.Config{RootCAs: roots}
	if certPEM != nil {
		pair, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil {
			t.Fatal(err)
		}
		cfg.Certificates = []tls.Certificate{pair}
	}
	tr := &http.Transport{TLSClientConfig: cfg}
	t.Cleanup(tr.CloseIdleConnections)
	return &http.Client{Transport: tr, Timeout: 10 * time.Second}
}

func (f *mtlsFixture) get(c *http.Client, path, token string) (*http.Response, error) {
	req, err := http.NewRequest(http.MethodGet, f.ts.URL+path, nil)
	if err != nil {
		return nil, err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return c.Do(req)
}

func TestMTLS_acceptedWithClientCertAndToken(t *testing.T) {
	f := newMTLSFixture(t)
	certPEM, keyPEM := f.clientCA.issue(t, "ops", x509.ExtKeyUsageClientAuth, time.Now().Add(time.Hour))
	resp, err := f.get(f.client(t, certPEM, keyPEM), "/api/v1/config", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if resp.TLS == nil || resp.TLS.Version != tls.VersionTLS13 {
		t.Fatalf("expected TLS 1.3, got %+v", resp.TLS)
	}
}

// X.509 treats a missing extended key usage as any usage; docs/http-api.md says so.
func TestMTLS_certWithoutExtKeyUsageAccepted(t *testing.T) {
	f := newMTLSFixture(t)
	certPEM, keyPEM := f.clientCA.issueWithUsages(t, "ops", nil, time.Now().Add(time.Hour))
	resp, err := f.get(f.client(t, certPEM, keyPEM), "/api/v1/config", "secret-token")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

// A valid certificate does not replace the token.
func TestMTLS_clientCertWithoutValidTokenUnauthorized(t *testing.T) {
	f := newMTLSFixture(t)
	certPEM, keyPEM := f.clientCA.issue(t, "ops", x509.ExtKeyUsageClientAuth, time.Now().Add(time.Hour))
	c := f.client(t, certPEM, keyPEM)
	for _, token := range []string{"", "wrong-token"} {
		resp, err := f.get(c, "/api/v1/config", token)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusUnauthorized {
			t.Fatalf("token %q: status %d", token, resp.StatusCode)
		}
	}
}

// A leaked token alone, or with a certificate that does not qualify, must not reach a handler.
func TestMTLS_refusedClientCertificates(t *testing.T) {
	f := newMTLSFixture(t)
	valid := time.Now().Add(time.Hour)
	otherCA := newTestCA(t, "other ca")

	type pair struct{ cert, key []byte }
	issue := func(ca *testCA, usage x509.ExtKeyUsage, notAfter time.Time) pair {
		c, k := ca.issue(t, "client", usage, notAfter)
		return pair{c, k}
	}
	tests := []struct {
		name string
		pair pair
	}{
		{"no certificate", pair{}},
		{"signed by another CA", issue(otherCA, x509.ExtKeyUsageClientAuth, valid)},
		{"expired", issue(f.clientCA, x509.ExtKeyUsageClientAuth, time.Now().Add(-time.Hour))},
		{"server auth usage only", issue(f.clientCA, x509.ExtKeyUsageServerAuth, valid)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			resp, err := f.get(f.client(t, tt.pair.cert, tt.pair.key), "/api/v1/config", "secret-token")
			if err == nil {
				resp.Body.Close()
				t.Fatalf("expected refused handshake, got status %d", resp.StatusCode)
			}
			// The server's alert, as opposed to this client failing to verify the server.
			if !strings.Contains(err.Error(), "remote error: tls") {
				t.Fatalf("expected the server to refuse the client, got %v", err)
			}
		})
	}
}

// The handshake applies to every route on this listener, including the unauthenticated probe.
func TestMTLS_healthzRequiresClientCert(t *testing.T) {
	f := newMTLSFixture(t)
	if resp, err := f.get(f.client(t, nil, nil), "/healthz", ""); err == nil {
		resp.Body.Close()
		t.Fatalf("expected refused handshake, got status %d", resp.StatusCode)
	}
	certPEM, keyPEM := f.clientCA.issue(t, "probe", x509.ExtKeyUsageClientAuth, time.Now().Add(time.Hour))
	resp, err := f.get(f.client(t, certPEM, keyPEM), "/healthz", "")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMTLS_plainHTTPClientRefused(t *testing.T) {
	f := newMTLSFixture(t)
	req, err := http.NewRequest(http.MethodGet, strings.Replace(f.ts.URL, "https://", "http://", 1)+"/api/v1/config", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer secret-token")
	resp, err := (&http.Client{Timeout: 10 * time.Second}).Do(req)
	if err != nil {
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status %d", resp.StatusCode)
	}
}

func TestMTLSConfig_offByDefault(t *testing.T) {
	s := &Server{Listen: "127.0.0.1:9847", Token: "t"}
	cfg, err := s.mtlsConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg != nil {
		t.Fatalf("expected no TLS config, got %+v", cfg)
	}
}

func TestMTLSConfig_failsClosed(t *testing.T) {
	dir := t.TempDir()
	ca := newTestCA(t, "ca")
	certPEM, keyPEM := ca.issue(t, "api", x509.ExtKeyUsageServerAuth, time.Now().Add(time.Hour))
	cert := writeTestFile(t, dir, "server.pem", certPEM)
	key := writeTestFile(t, dir, "server.key", keyPEM)
	caFile := writeTestFile(t, dir, "ca.pem", ca.pem)
	notPEM := writeTestFile(t, dir, "empty.pem", []byte("not a certificate\n"))
	missing := filepath.Join(dir, "missing.pem")

	tests := []struct {
		name                  string
		listen, cert, key, ca string
		wantErr               string
	}{
		{"listen only", "127.0.0.1:0", "", "", "", "set together"},
		{"no client CA", "127.0.0.1:0", cert, key, "", "set together"},
		{"no listen", "", cert, key, caFile, "set together"},
		{"missing server cert", "127.0.0.1:0", missing, key, caFile, "server certificate"},
		{"key does not match", "127.0.0.1:0", caFile, key, caFile, "server certificate"},
		{"missing client CA", "127.0.0.1:0", cert, key, missing, "client CA"},
		{"client CA without certificates", "127.0.0.1:0", cert, key, notPEM, "no certificates"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Server{MTLSListen: tt.listen, MTLSCertFile: tt.cert, MTLSKeyFile: tt.key, MTLSClientCAFile: tt.ca}
			_, err := s.mtlsConfig()
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("got %v, want error containing %q", err, tt.wantErr)
			}
		})
	}
}

// Run must refuse to start, not start without mTLS, when the mTLS setup is incomplete.
func TestRun_partialMTLSReturnsError(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	s := &Server{Listen: "127.0.0.1:0", Token: "t", Config: cfgPath, MTLSListen: "127.0.0.1:0"}
	done := make(chan error, 1)
	go func() { done <- s.Run() }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "set together") {
			t.Fatalf("got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run kept serving with a partial mTLS setup")
	}
}

// Losing the mTLS listener ends Run even though the plain listener is healthy.
func TestRun_mtlsBindFailureReturnsError(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "c.yaml")
	writeMinimalConfig(t, cfgPath)
	occupied, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	ca := newTestCA(t, "ca")
	certPEM, keyPEM := ca.issue(t, "api", x509.ExtKeyUsageServerAuth, time.Now().Add(time.Hour))
	s := &Server{
		Listen:           "127.0.0.1:0",
		Token:            "t",
		Config:           cfgPath,
		MTLSListen:       occupied.Addr().String(),
		MTLSCertFile:     writeTestFile(t, dir, "server.pem", certPEM),
		MTLSKeyFile:      writeTestFile(t, dir, "server.key", keyPEM),
		MTLSClientCAFile: writeTestFile(t, dir, "ca.pem", ca.pem),
	}
	done := make(chan error, 1)
	go func() { done <- s.Run() }()
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "address already in use") {
			t.Fatalf("got %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Run kept serving without the mTLS listener")
	}
}

func TestReachableBeyondLoopback(t *testing.T) {
	on := &tls.Config{}
	tests := []struct {
		name         string
		listen, mtls string
		cfg          *tls.Config
		want         bool
	}{
		{"plain loopback, mTLS off", "127.0.0.1:9847", "", nil, false},
		{"plain public, mTLS off", "0.0.0.0:9847", "", nil, true},
		{"plain loopback, mTLS public", "127.0.0.1:9847", "0.0.0.0:9848", on, true},
		{"plain off, mTLS loopback", "", "127.0.0.1:9848", on, false},
		{"plain off, mTLS public", "", "10.0.0.1:9848", on, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Server{Listen: tt.listen, MTLSListen: tt.mtls}
			if got := s.reachableBeyondLoopback(tt.cfg); got != tt.want {
				t.Fatalf("got %v", got)
			}
		})
	}
}
