package apply

import (
	"context"
	"fmt"
	"strings"
)

// GenerateWireGuardPrivateKey runs `wg genkey`.
func GenerateWireGuardPrivateKey() (string, error) {
	out, err := runCmdOutput(context.Background(), "wg", "genkey")
	if err != nil {
		return "", fmt.Errorf("wg genkey: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// GenerateWireGuardKeypair runs `wg genkey` and `wg pubkey`.
func GenerateWireGuardKeypair() (privateKey, publicKey string, err error) {
	privateKey, err = GenerateWireGuardPrivateKey()
	if err != nil {
		return "", "", err
	}
	publicKey, err = WireGuardPublicKey(privateKey)
	if err != nil {
		return "", "", err
	}
	return privateKey, publicKey, nil
}

// WireGuardPublicKey runs `wg pubkey` with the given private key on stdin.
func WireGuardPublicKey(privateKey string) (string, error) {
	out, err := runCmdOutputStdin(context.Background(), strings.TrimSpace(privateKey)+"\n", "wg", "pubkey")
	if err != nil {
		return "", fmt.Errorf("wg pubkey: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}
