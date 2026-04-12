package config

import (
	"fmt"
	"regexp"
	"strings"
)

var (
	reLinuxIface = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,15}$`)
	reNFTSetName = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]*$`)
	rePeerName   = regexp.MustCompile(`^[a-zA-Z0-9_ .+@/-]{1,64}$`)
)

func validLinuxIface(name string) error {
	name = strings.TrimSpace(name)
	if !reLinuxIface.MatchString(name) {
		return fmt.Errorf("invalid interface name %q (use 1–15 chars: letters, digits, . _ -)", name)
	}
	return nil
}

func validNFTSetName(name string) error {
	name = strings.TrimSpace(name)
	if !reNFTSetName.MatchString(name) {
		return fmt.Errorf("invalid nft set name %q (letters, digits, underscore; must start with letter or _)", name)
	}
	return nil
}

func validPeerName(name string) error {
	if strings.ContainsAny(name, "\r\n\x00") {
		return fmt.Errorf("peer name cannot contain newlines or control characters")
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return nil
	}
	if !rePeerName.MatchString(name) {
		return fmt.Errorf("invalid peer name %q (1–64 chars: letters, digits, space, _ . + @ / -)", name)
	}
	return nil
}

func validateGeoCountryCode(cc string) error {
	cc = strings.ToLower(strings.TrimSpace(cc))
	if len(cc) != 2 || cc[0] < 'a' || cc[0] > 'z' || cc[1] < 'a' || cc[1] > 'z' {
		return fmt.Errorf("country code %q must be two lowercase letters (ISO 3166-1 alpha-2)", cc)
	}
	return nil
}

// ValidateInputAllowDport checks that dport is safe to embed in generated nftables (port, range, or brace list).
func ValidateInputAllowDport(d string) error {
	d = strings.TrimSpace(d)
	if d == "" {
		return fmt.Errorf("dport is required")
	}
	if strings.ContainsAny(d, "\n\r;\"'`!$&|") {
		return fmt.Errorf("dport contains forbidden characters")
	}
	if strings.Contains(d, "{") {
		return validateBraceDport(d)
	}
	return validatePlainDportToken(d)
}

func validateBraceDport(d string) error {
	d = strings.TrimSpace(d)
	if !strings.HasPrefix(d, "{") || !strings.HasSuffix(d, "}") {
		return fmt.Errorf("brace dport must be a single {...} list")
	}
	inner := strings.TrimSpace(d[1 : len(d)-1])
	if inner == "" {
		return fmt.Errorf("empty port list inside braces")
	}
	for _, part := range strings.Split(inner, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			return fmt.Errorf("empty entry in brace list")
		}
		if strings.ContainsAny(part, "{}") {
			return fmt.Errorf("nested braces are not allowed in dport")
		}
		if err := validatePlainDportToken(part); err != nil {
			return err
		}
	}
	return nil
}

func validatePlainDportToken(tok string) error {
	tok = strings.TrimSpace(tok)
	if tok == "" {
		return fmt.Errorf("empty port token")
	}
	if strings.ContainsAny(tok, " {}") {
		return fmt.Errorf("invalid dport %q", tok)
	}
	if strings.Count(tok, "-") > 1 {
		return fmt.Errorf("invalid dport %q", tok)
	}
	i := strings.Index(tok, "-")
	if i < 0 {
		_, err := parsePort(tok)
		return err
	}
	lo, err := parsePort(tok[:i])
	if err != nil {
		return err
	}
	hi, err := parsePort(tok[i+1:])
	if err != nil {
		return err
	}
	if lo > hi {
		return fmt.Errorf("port range low exceeds high in %q", tok)
	}
	return nil
}

func parsePort(s string) (int, error) {
	if s == "" || len(s) > 5 {
		return 0, fmt.Errorf("invalid port %q", s)
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("invalid port %q", s)
		}
	}
	n := 0
	for _, c := range s {
		n = n*10 + int(c-'0')
	}
	if n < 1 || n > 65535 {
		return 0, fmt.Errorf("port %d out of range (1–65535)", n)
	}
	return n, nil
}
