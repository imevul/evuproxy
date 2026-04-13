package apply

import (
	"fmt"
	"os/exec"
	"strings"
)

// GenerateWireGuardPrivateKey runs `wg genkey`.
func GenerateWireGuardPrivateKey() (string, error) {
	out, err := exec.Command("wg", "genkey").Output()
	if err != nil {
		return "", fmt.Errorf("wg genkey: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}

// WireGuardPublicKey runs `wg pubkey` with the given private key on stdin.
func WireGuardPublicKey(privateKey string) (string, error) {
	cmd := exec.Command("wg", "pubkey")
	cmd.Stdin = strings.NewReader(strings.TrimSpace(privateKey) + "\n")
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("wg pubkey: %w", err)
	}
	return strings.TrimSpace(string(out)), nil
}
