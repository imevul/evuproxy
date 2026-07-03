package apply

const (
	ClientIPSourceDirect      = "direct"
	ClientIPSourceXFF         = "xff"
	ClientIPSourceUnavailable = "unavailable"
)

// ClientIPInfo describes how the API inferred the operator's IPv4 address.
// Detection itself lives in internal/api (transport concern); this type stays
// here because validation warnings embed it in their results.
type ClientIPInfo struct {
	IP     string `json:"detected_client_ip,omitempty"`
	Source string `json:"ip_detection_source"`
	Note   string `json:"ip_detection_note,omitempty"`
}
