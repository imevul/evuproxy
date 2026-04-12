package api

import (
	"net/http"
	"strings"
)

type corsRule struct {
	allowAll bool
	origins  map[string]struct{}
}

func parseCORSOrigins(csv string) *corsRule {
	csv = strings.TrimSpace(csv)
	if csv == "" {
		return nil
	}
	if csv == "*" {
		return &corsRule{allowAll: true}
	}
	var list []string
	for _, p := range strings.Split(csv, ",") {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if p == "*" {
			return &corsRule{allowAll: true}
		}
		list = append(list, p)
	}
	if len(list) == 0 {
		return nil
	}
	m := make(map[string]struct{}, len(list))
	for _, o := range list {
		m[o] = struct{}{}
	}
	return &corsRule{origins: m}
}

// allow reports whether the request Origin may receive CORS headers and the
// value for Access-Control-Allow-Origin (either "*" or the echoed Origin).
func (c *corsRule) allow(origin string) (acao string, ok bool) {
	if c == nil {
		return "", false
	}
	origin = strings.TrimSpace(origin)
	if c.allowAll {
		return "*", true
	}
	if origin == "" {
		return "", false
	}
	if _, exists := c.origins[origin]; !exists {
		return "", false
	}
	return origin, true
}

func (c *corsRule) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acao, ok := c.allow(r.Header.Get("Origin"))
		if ok {
			w.Header().Set("Access-Control-Allow-Origin", acao)
			if acao != "*" {
				w.Header().Add("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Token, Accept")
			w.Header().Set("Access-Control-Max-Age", "86400")
		}
		if r.Method == http.MethodOptions {
			if ok {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}
