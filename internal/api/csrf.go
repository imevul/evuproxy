package api

import (
	"net/http"
)

// crossOriginGuard refuses state-changing browser requests from origins other than the API's own
// and those listed in --cors-origins. The API token alone already stops CSRF, because browsers do
// not attach it by themselves. This covers deployments where something in front of the API does
// attach credentials automatically: a reverse proxy that injects the token behind basic auth, an
// SSO cookie or a client certificate.
//
// Requests without Sec-Fetch-Site and Origin are allowed, so curl, CI and other non-browser clients
// are unaffected. "--cors-origins *" turns the guard off, since it already trusts every origin.
func (s *Server) crossOriginGuard(next http.Handler) http.Handler {
	cors := parseCORSOrigins(s.CORSOrigins)
	if cors != nil && cors.allowAll {
		return next
	}
	guard := http.NewCrossOriginProtection()
	if cors != nil {
		for origin := range cors.origins {
			// A trailing slash or a path never matches a browser Origin. "null" could match, but any
			// sandboxed page can send it, so it must not be trusted here.
			if err := guard.AddTrustedOrigin(origin); err != nil && s.Logger != nil {
				s.Logger.Warn("ignoring --cors-origins value for cross-origin checks", "origin", origin, "err", err)
			}
		}
	}
	guard.SetDenyHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if s.Logger != nil {
			s.Logger.Warn("refused cross-origin request",
				"method", r.Method,
				"path", r.URL.Path,
				"origin", r.Header.Get("Origin"),
				"sec_fetch_site", r.Header.Get("Sec-Fetch-Site"),
				"host", r.Host,
			)
		}
		s.jsonAPIError(w, http.StatusForbidden,
			"cross-origin request refused: list this UI origin in evuproxy serve --cors-origins, or make the reverse proxy forward the original Host header",
			"cross_origin_refused")
	}))
	return guard.Handler(next)
}
