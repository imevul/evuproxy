package apply

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/oschwald/geoip2-golang"

	"github.com/imevul/evuproxy/internal/config"
	"github.com/imevul/evuproxy/internal/gen"
)

// ValidateIssue is a single validation failure with optional stable code.
type ValidateIssue struct {
	Code    string `json:"code,omitempty"`
	Message string `json:"message"`
}

// ValidateResult is the outcome of a dry-run validate (no apply, no .bak changes).
type ValidateResult struct {
	OK                 bool             `json:"ok"`
	Errors             []ValidateIssue  `json:"errors,omitempty"`
	Warnings           []LockoutWarning `json:"warnings,omitempty"`
	DetectedClientIP   string           `json:"detected_client_ip,omitempty"`
	IPDetectionSource  string           `json:"ip_detection_source"`
	IPDetectionNote    string           `json:"ip_detection_note,omitempty"`
	ValidatedFromDraft bool             `json:"validated_from_draft,omitempty"`
}

// ValidateConfig runs schema validation, artifact generation, and nft -c without applying.
func ValidateConfig(c *config.Config) *ValidateResult {
	res := &ValidateResult{OK: true, IPDetectionSource: ClientIPSourceUnavailable}
	if c == nil {
		res.OK = false
		res.Errors = append(res.Errors, ValidateIssue{Message: "config is nil"})
		return res
	}
	c.Normalize()
	if err := c.Validate(); err != nil {
		res.OK = false
		res.Errors = append(res.Errors, validationIssueFromErr(err))
		return res
	}
	if _, err := gen.WireGuardConf(c); err != nil {
		res.OK = false
		res.Errors = append(res.Errors, ValidateIssue{Message: err.Error()})
		return res
	}
	nftSrc, err := gen.NFTables(c)
	if err != nil {
		res.OK = false
		res.Errors = append(res.Errors, validationIssueFromErr(err))
		return res
	}
	if err := checkNFTablesSyntax(nftSrc); err != nil {
		res.OK = false
		res.Errors = append(res.Errors, ValidateIssue{Message: err.Error()})
	}
	return res
}

// ValidateConfigWithWarnings runs ValidateConfig and appends lockout warnings for clientIP.
func ValidateConfigWithWarnings(c *config.Config, clientIP ClientIPInfo, geoReader *geoip2.Reader, fromDraft bool) *ValidateResult {
	res := ValidateConfig(c)
	res.DetectedClientIP = clientIP.IP
	res.IPDetectionSource = clientIP.Source
	res.IPDetectionNote = clientIP.Note
	res.ValidatedFromDraft = fromDraft
	if clientIP.IP != "" {
		res.Warnings = LockoutWarnings(c, clientIP.IP, geoReader)
	}
	return res
}

func validationIssueFromErr(err error) ValidateIssue {
	if err == nil {
		return ValidateIssue{}
	}
	var ve *config.ValidationError
	if errors.As(err, &ve) && ve != nil {
		return ValidateIssue{Code: ve.Code, Message: ve.Msg}
	}
	return ValidateIssue{Message: err.Error()}
}

func checkNFTablesSyntax(nftSrc string) error {
	f, err := os.CreateTemp("", "evuproxy-validate-*.nft")
	if err != nil {
		return fmt.Errorf("temp nft file: %w", err)
	}
	path := f.Name()
	defer os.Remove(path)
	if _, err := f.WriteString(nftSrc); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	out, err := runCmdCombined(context.Background(), "nft", "-c", "-f", path)
	if err != nil {
		return fmt.Errorf("nft validate: %w\n%s", err, TruncateForLog(string(out), 8192))
	}
	return nil
}

// ValidateConfigFileCLI is used by evuproxy validate; prints human-readable output to stderr on failure.
func ValidateConfigFileCLI(cfgPath string, jsonOut bool, clientIP ClientIPInfo, geoReader *geoip2.Reader) (int, error) {
	c, err := config.Load(cfgPath)
	if err != nil {
		if jsonOut {
			printValidateJSON(&ValidateResult{
				OK:                false,
				Errors:            []ValidateIssue{{Message: err.Error()}},
				IPDetectionSource: clientIP.Source,
				DetectedClientIP:  clientIP.IP,
				IPDetectionNote:   clientIP.Note,
			})
			return 1, nil
		}
		return 1, err
	}
	res := ValidateConfigWithWarnings(c, clientIP, geoReader, false)
	if jsonOut {
		printValidateJSON(res)
		if !res.OK {
			return 1, nil
		}
		return 0, nil
	}
	for _, w := range res.Warnings {
		fmt.Fprintf(os.Stderr, "warning [%s]: %s\n", w.Code, w.Message)
	}
	if !res.OK {
		for _, e := range res.Errors {
			if e.Code != "" {
				fmt.Fprintf(os.Stderr, "error [%s]: %s\n", e.Code, e.Message)
			} else {
				fmt.Fprintf(os.Stderr, "error: %s\n", e.Message)
			}
		}
		return 1, fmt.Errorf("validation failed")
	}
	return 0, nil
}

func printValidateJSON(res *ValidateResult) {
	b, err := json.Marshal(res)
	if err != nil {
		fmt.Fprintf(os.Stderr, "marshal: %v\n", err)
		return
	}
	fmt.Println(string(b))
}
