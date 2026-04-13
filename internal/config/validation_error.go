package config

// ValidationError is returned from Validate and related checks with a stable machine-readable Code
// for HTTP clients and audit logs.
type ValidationError struct {
	Code string `json:"code"`
	Msg  string `json:"message"`
}

func (e *ValidationError) Error() string {
	if e == nil {
		return ""
	}
	return e.Msg
}
