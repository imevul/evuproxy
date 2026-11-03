// Command server stands in for GitHub Releases in the upgrade test, over HTTPS because
// scripts/upgrade-binary.sh refuses anything else. It only listens inside the test's container.
//
//	server -dir DIR -addr 127.0.0.1:8443 -ca CA.pem
//
// DIR/latest holds the latest version, and DIR/vX.Y.Z/ holds that release's assets. An empty
// file named ASSET.truncate cuts ASSET's download off halfway. The certificate is generated at
// startup and written to the -ca file, for curl's CURL_CA_BUNDLE.
package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"flag"
	"log"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func main() {
	dir := flag.String("dir", "", "directory of releases")
	addr := flag.String("addr", "127.0.0.1:8443", "listen address")
	caPath := flag.String("ca", "", "where to write the CA certificate")
	flag.Parse()

	cert, err := selfSigned(*caPath)
	if err != nil {
		log.Fatal(err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /releases/latest", func(w http.ResponseWriter, r *http.Request) {
		b, err := os.ReadFile(filepath.Join(*dir, "latest"))
		if err != nil {
			http.NotFound(w, r)
			return
		}
		http.Redirect(w, r, "/releases/tag/v"+strings.TrimSpace(string(b)), http.StatusFound)
	})
	mux.HandleFunc("GET /releases/tag/{tag}", func(w http.ResponseWriter, r *http.Request) {})
	mux.HandleFunc("GET /releases/download/{tag}/{asset}", func(w http.ResponseWriter, r *http.Request) {
		// PathValue can't hold a slash, so these stay inside dir.
		path := filepath.Join(*dir, r.PathValue("tag"), r.PathValue("asset"))
		if _, err := os.Stat(path + ".truncate"); err == nil {
			b, err := os.ReadFile(path)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Length", strconv.Itoa(len(b)))
			_, _ = w.Write(b[:len(b)/2])
			panic(http.ErrAbortHandler)
		}
		http.ServeFile(w, r, path)
	})

	srv := &http.Server{
		Addr:              *addr,
		Handler:           mux,
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}},
		ReadHeaderTimeout: 10 * time.Second,
	}
	log.Fatal(srv.ListenAndServeTLS("", ""))
}

func selfSigned(caPath string) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "upgrade-test"},
		DNSNames:              []string{"localhost"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		BasicConstraintsValid: true,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, key.Public(), key)
	if err != nil {
		return tls.Certificate{}, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	if err := os.WriteFile(caPath, certPEM, 0o644); err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
