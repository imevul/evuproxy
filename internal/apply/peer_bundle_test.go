package apply

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"testing"

	"golang.org/x/crypto/pbkdf2"
)

func TestEncryptPeerOnboardBundleRoundtrip(t *testing.T) {
	pass := "0123456789abcdef0123456789abcdef"
	params := PeerOnboardBundleParams{
		PeerPrivateKey:  "aGVsbG8=",
		PeerTunnelAddr:  "10.100.0.2/32",
		ServerPublicKey: "c2VydmVy",
		Endpoint:        "203.0.113.1:51820",
		AllowedIPs:      "10.100.0.0/24",
		InterfaceName:   "evuproxy",
	}
	blob, err := EncryptPeerOnboardBundle(pass, params)
	if err != nil {
		t.Fatal(err)
	}
	if len(blob) < 64 {
		t.Fatalf("blob too short: %d", len(blob))
	}
	if string(blob[:4]) != peerBundleMagic {
		t.Fatalf("bad magic %q", blob[:4])
	}
	if blob[4] != peerBundleVersion {
		t.Fatalf("bad version %d", blob[4])
	}
	iter := binary.BigEndian.Uint32(blob[5:9])
	if iter != peerBundlePBKDF2Iter {
		t.Fatalf("bad iter %d", iter)
	}
	if blob[9] != peerBundleSaltLen {
		t.Fatalf("bad salt len %d", blob[9])
	}
	salt := blob[10 : 10+peerBundleSaltLen]
	iv := blob[26 : 26+peerBundleIVLen]
	ctLen := binary.BigEndian.Uint32(blob[42:46])
	ct := blob[46 : 46+int(ctLen)]
	mac := blob[46+int(ctLen):]

	dk := pbkdf2.Key([]byte(pass), salt, peerBundlePBKDF2Iter, 64, sha256.New)
	macKey := dk[32:64]
	macPayload := append(append([]byte{}, iv...), ct...)
	h := hmac.New(sha256.New, macKey)
	h.Write(macPayload)
	if !hmac.Equal(mac, h.Sum(nil)) {
		t.Fatal("MAC mismatch")
	}

	block, err := aes.NewCipher(dk[:32])
	if err != nil {
		t.Fatal(err)
	}
	plainPadded := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(plainPadded, ct)
	pad := int(plainPadded[len(plainPadded)-1])
	if pad <= 0 || pad > aes.BlockSize {
		t.Fatalf("bad pkcs7 pad %d", pad)
	}
	plain := plainPadded[:len(plainPadded)-pad]

	var got struct {
		V               int    `json:"v"`
		PeerPrivateKey  string `json:"peerPrivateKey"`
		PeerTunnelAddr  string `json:"peerTunnelAddress"`
		ServerPublicKey string `json:"serverPublicKey"`
		Endpoint        string `json:"endpoint"`
		AllowedIPs      string `json:"allowedIPs"`
		InterfaceName   string `json:"interfaceName"`
	}
	if err := json.Unmarshal(plain, &got); err != nil {
		t.Fatal(err)
	}
	if got.V != peerBundleVersion || got.PeerPrivateKey != params.PeerPrivateKey || got.PeerTunnelAddr != params.PeerTunnelAddr ||
		got.ServerPublicKey != params.ServerPublicKey || got.Endpoint != params.Endpoint || got.AllowedIPs != params.AllowedIPs ||
		got.InterfaceName != params.InterfaceName {
		t.Fatalf("decoded mismatch: %+v", got)
	}
}
