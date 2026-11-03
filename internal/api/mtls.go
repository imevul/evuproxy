package api

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
)

// mtlsConfig returns the TLS config for the optional mTLS listener, or nil when none of the
// mTLS settings are present. A partial or unusable setup is an error so that serve never
// falls back to running without the client certificate check the operator asked for.
func (s *Server) mtlsConfig() (*tls.Config, error) {
	listen := strings.TrimSpace(s.MTLSListen)
	certFile := strings.TrimSpace(s.MTLSCertFile)
	keyFile := strings.TrimSpace(s.MTLSKeyFile)
	caFile := strings.TrimSpace(s.MTLSClientCAFile)
	if listen == "" && certFile == "" && keyFile == "" && caFile == "" {
		return nil, nil
	}
	if listen == "" || certFile == "" || keyFile == "" || caFile == "" {
		return nil, errors.New("mtls: --mtls-listen, --mtls-cert, --mtls-key and --mtls-client-ca must be set together")
	}
	cert, err := tls.LoadX509KeyPair(certFile, keyFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: server certificate: %w", err)
	}
	caPEM, err := os.ReadFile(caFile)
	if err != nil {
		return nil, fmt.Errorf("mtls: client CA: %w", err)
	}
	clientCAs := x509.NewCertPool()
	if !clientCAs.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("mtls: client CA: no certificates found in %s", caFile)
	}
	// TLS 1.3 encrypts the client certificate in the handshake; 1.2 sends it in the clear.
	return &tls.Config{
		Certificates: []tls.Certificate{cert},
		ClientAuth:   tls.RequireAndVerifyClientCert,
		ClientCAs:    clientCAs,
		MinVersion:   tls.VersionTLS13,
	}, nil
}

// plainListenDisabled reports whether the token-only listener is switched off, which is only
// possible while the mTLS listener is on. Otherwise an empty Listen keeps net/http's default.
func (s *Server) plainListenDisabled(mtls *tls.Config) bool {
	return mtls != nil && strings.TrimSpace(s.Listen) == ""
}

// reachableBeyondLoopback reports whether any active listener binds a non-loopback address.
func (s *Server) reachableBeyondLoopback(mtls *tls.Config) bool {
	if mtls != nil && !isLoopbackListen(s.MTLSListen) {
		return true
	}
	return !s.plainListenDisabled(mtls) && !isLoopbackListen(s.Listen)
}
