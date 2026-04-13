package apply

import "unicode/utf8"

// TruncateForLog returns s shortened to at most max bytes without breaking a UTF-8 code point.
func TruncateForLog(s string, max int) string {
	if max <= 0 || len(s) <= max {
		return s
	}
	s = s[:max]
	for !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s + "…(truncated)"
}
