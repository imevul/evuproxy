package apply

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"fmt"

	"golang.org/x/crypto/pbkdf2"
)

const (
	peerBundleMagic      = "EVUB"
	peerBundleVersion    = 1
	peerBundlePBKDF2Iter = 310000
	peerBundleSaltLen    = 16
	peerBundleIVLen      = 16
)

// PeerOnboardBundleParams is the cleartext WireGuard material encrypted into an EVUB blob.
type PeerOnboardBundleParams struct {
	PeerPrivateKey  string `json:"peerPrivateKey"`
	PeerTunnelAddr  string `json:"peerTunnelAddress"`
	ServerPublicKey string `json:"serverPublicKey"`
	Endpoint        string `json:"endpoint"`
	AllowedIPs      string `json:"allowedIPs"`
	InterfaceName   string `json:"interfaceName"`
}

// EncryptPeerOnboardBundle builds an EVUB blob (wire format matches web/static/app.js).
func EncryptPeerOnboardBundle(passphrase string, p PeerOnboardBundleParams) ([]byte, error) {
	if passphrase == "" {
		return nil, fmt.Errorf("passphrase required")
	}
	if p.PeerPrivateKey == "" || p.PeerTunnelAddr == "" || p.ServerPublicKey == "" || p.Endpoint == "" || p.AllowedIPs == "" {
		return nil, fmt.Errorf("incomplete WireGuard onboarding parameters")
	}
	if p.InterfaceName == "" {
		p.InterfaceName = "evuproxy"
	}
	plainObj := struct {
		V               int    `json:"v"`
		PeerPrivateKey  string `json:"peerPrivateKey"`
		PeerTunnelAddr  string `json:"peerTunnelAddress"`
		ServerPublicKey string `json:"serverPublicKey"`
		Endpoint        string `json:"endpoint"`
		AllowedIPs      string `json:"allowedIPs"`
		InterfaceName   string `json:"interfaceName"`
	}{
		V:               peerBundleVersion,
		PeerPrivateKey:  p.PeerPrivateKey,
		PeerTunnelAddr:  p.PeerTunnelAddr,
		ServerPublicKey: p.ServerPublicKey,
		Endpoint:        p.Endpoint,
		AllowedIPs:      p.AllowedIPs,
		InterfaceName:   p.InterfaceName,
	}
	plain, err := json.Marshal(plainObj)
	if err != nil {
		return nil, err
	}

	salt := make([]byte, peerBundleSaltLen)
	if _, err := rand.Read(salt); err != nil {
		return nil, err
	}
	iv := make([]byte, peerBundleIVLen)
	if _, err := rand.Read(iv); err != nil {
		return nil, err
	}

	dk := pbkdf2.Key([]byte(passphrase), salt, peerBundlePBKDF2Iter, 64, sha256.New)
	aesKey := dk[:32]
	macKey := dk[32:64]

	block, err := aes.NewCipher(aesKey)
	if err != nil {
		return nil, err
	}
	padded := pkcs7Pad(plain, aes.BlockSize)
	ciphertext := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(ciphertext, padded)

	macPayload := append(append([]byte{}, iv...), ciphertext...)
	mac := hmac.New(sha256.New, macKey)
	mac.Write(macPayload)
	macSum := mac.Sum(nil)

	headerLen := 4 + 1 + 4 + 1 + peerBundleSaltLen + peerBundleIVLen + 4
	out := make([]byte, headerLen+len(ciphertext)+len(macSum))
	o := 0
	copy(out[o:], peerBundleMagic)
	o += 4
	out[o] = peerBundleVersion
	o++
	binary.BigEndian.PutUint32(out[o:], peerBundlePBKDF2Iter)
	o += 4
	out[o] = peerBundleSaltLen
	o++
	copy(out[o:], salt)
	o += peerBundleSaltLen
	copy(out[o:], iv)
	o += peerBundleIVLen
	binary.BigEndian.PutUint32(out[o:], uint32(len(ciphertext)))
	o += 4
	copy(out[o:], ciphertext)
	o += len(ciphertext)
	copy(out[o:], macSum)
	return out, nil
}

func pkcs7Pad(data []byte, blockSize int) []byte {
	pad := blockSize - len(data)%blockSize
	if pad == 0 {
		pad = blockSize
	}
	out := make([]byte, len(data)+pad)
	copy(out, data)
	for i := len(data); i < len(out); i++ {
		out[i] = byte(pad)
	}
	return out
}
