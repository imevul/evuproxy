package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// wantRouteScopes is the classification on purpose: a new route fails here until someone
// decides what a monitoring token may do with it.
var wantRouteScopes = map[string]tokenScope{
	"GET /api/v1/status":        scopeRead,
	"GET /api/v1/overview":      scopeRead,
	"GET /api/v1/stats":         scopeRead,
	"GET /api/v1/logs":          scopeRead,
	"GET /api/v1/events":        scopeRead,
	"GET /api/v1/metrics":       scopeRead,
	"GET /api/v1/metrics/peers": scopeRead,

	// Secret-bearing or network layout, so write even though they only read.
	"GET /api/v1/config":                scopeWrite,
	"GET /api/v1/config.yaml":           scopeWrite,
	"GET /api/v1/diagnostics.md":        scopeWrite,
	"POST /api/v1/backup":               scopeWrite,
	"GET /api/v1/backup/info":           scopeWrite,
	"POST /api/v1/peers/onboard-bundle": scopeWrite,
	"GET /api/v1/pending":               scopeWrite,
	"GET /api/v1/preferences":           scopeWrite,
	"GET /api/v1/config/notes":          scopeWrite,
	"GET /api/v1/auto-pause":            scopeWrite,
	"GET /api/v1/geo/summary":           scopeWrite,
	"GET /api/v1/client-ip":             scopeWrite,
	"GET /api/v1/about":                 scopeWrite,
	"GET /api/v1/reload/progress":       scopeWrite,
	"GET /api/v1/apply/session":         scopeWrite,
	"GET /api/v1/stats/route-accepted":  scopeWrite,

	"POST /api/v1/reload":                          scopeWrite,
	"POST /api/v1/apply/confirm":                   scopeWrite,
	"POST /api/v1/apply/revert":                    scopeWrite,
	"POST /api/v1/apply/reverted/restore":          scopeWrite,
	"POST /api/v1/apply/reverted/dismiss":          scopeWrite,
	"POST /api/v1/update-geo":                      scopeWrite,
	"POST /api/v1/geo/check-ip":                    scopeWrite,
	"POST /api/v1/routes/test":                     scopeWrite,
	"PUT /api/v1/config":                           scopeWrite,
	"POST /api/v1/config/discard":                  scopeWrite,
	"POST /api/v1/config/restore-previous-applied": scopeWrite,
	"POST /api/v1/validate":                        scopeWrite,
	"POST /api/v1/peers/{index}/qr.png":            scopeWrite,
	"POST /api/v1/peers/generate-keypair":          scopeWrite,
	"PUT /api/v1/preferences":                      scopeWrite,
	"PUT /api/v1/config/notes":                     scopeWrite,
	"POST /api/v1/restore":                         scopeWrite,
}

func scopedServer(t *testing.T) *Server {
	t.Helper()
	cfgPath := filepath.Join(t.TempDir(), "c.yaml")
	writeMinimalConfig(t, cfgPath)
	return &Server{Token: "write-tok", ReadToken: "read-tok", Config: cfgPath, Listen: "127.0.0.1:0"}
}

// requestFor turns a route pattern into a request on that route.
func requestFor(t *testing.T, base, pattern, tok string) *http.Request {
	t.Helper()
	method, path, ok := strings.Cut(pattern, " ")
	if !ok {
		t.Fatalf("pattern %q has no method", pattern)
	}
	req, err := http.NewRequest(method, base+strings.ReplaceAll(path, "{index}", "0"), nil)
	if err != nil {
		t.Fatal(err)
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	return req
}

func TestScopes_everyRouteClassified(t *testing.T) {
	s := scopedServer(t)
	seen := map[string]bool{}
	for _, route := range s.apiRoutes() {
		seen[route.pattern] = true
		want, ok := wantRouteScopes[route.pattern]
		if !ok {
			t.Errorf("%s is not in wantRouteScopes: decide its scope", route.pattern)
			continue
		}
		if route.scope != want {
			t.Errorf("%s has scope %s, want %s", route.pattern, route.scope, want)
		}
	}
	var missing []string
	for pattern := range wantRouteScopes {
		if !seen[pattern] {
			missing = append(missing, pattern)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 {
		t.Errorf("not registered any more: %v", missing)
	}
}

func TestScopes_unclassifiedRouteNeedsWrite(t *testing.T) {
	if (apiRoute{}).scope != scopeWrite {
		t.Fatal("a route without a scope must need the write token")
	}
}

func TestScopes_readRoutesOnlyRead(t *testing.T) {
	for _, route := range scopedServer(t).apiRoutes() {
		if route.scope == scopeRead && !strings.HasPrefix(route.pattern, "GET ") {
			t.Errorf("%s changes state but is open to the read token", route.pattern)
		}
	}
}

// Only auth runs for these: every request is refused before its handler, so none of them
// touches nftables, WireGuard or the config.
func TestScopes_readTokenRefusedOnWriteRoutes(t *testing.T) {
	s := scopedServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	for _, route := range s.apiRoutes() {
		if route.scope != scopeWrite {
			continue
		}
		resp, err := http.DefaultClient.Do(requestFor(t, ts.URL, route.pattern, "read-tok"))
		if err != nil {
			t.Fatal(err)
		}
		var body map[string]string
		_ = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusForbidden {
			t.Errorf("%s: status %d, want 403", route.pattern, resp.StatusCode)
		}
		if body["error_code"] != insufficientScopeCode {
			t.Errorf("%s: error_code %q", route.pattern, body["error_code"])
		}
	}
}

func TestScopes_badTokenUnauthorizedOnEveryRoute(t *testing.T) {
	s := scopedServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	for _, route := range s.apiRoutes() {
		for _, tok := range []string{"", "wrong"} {
			resp, err := http.DefaultClient.Do(requestFor(t, ts.URL, route.pattern, tok))
			if err != nil {
				t.Fatal(err)
			}
			resp.Body.Close()
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("%s with token %q: status %d, want 401", route.pattern, tok, resp.StatusCode)
			}
		}
	}
}

// A stub handler, because the real write routes would change the host.
func TestScopes_authMatrix(t *testing.T) {
	s := scopedServer(t)
	cases := []struct {
		name  string
		scope tokenScope
		tok   string
		want  int
	}{
		{"write token on write route", scopeWrite, "write-tok", http.StatusOK},
		{"write token on read route", scopeRead, "write-tok", http.StatusOK},
		{"read token on read route", scopeRead, "read-tok", http.StatusOK},
		{"read token on write route", scopeWrite, "read-tok", http.StatusForbidden},
		{"bad token on read route", scopeRead, "nope", http.StatusUnauthorized},
		{"bad token on write route", scopeWrite, "nope", http.StatusUnauthorized},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("X-API-Token", c.tok)
			s.auth(c.scope, func(w http.ResponseWriter, r *http.Request) {})(rec, req)
			if rec.Code != c.want {
				t.Fatalf("status %d, want %d", rec.Code, c.want)
			}
		})
	}
}

func TestScopes_withoutReadTokenNothingMatchesIt(t *testing.T) {
	s := scopedServer(t)
	s.ReadToken = ""
	for _, tok := range []string{"", "read-tok"} {
		if _, ok := s.scopeOf(tok); ok {
			t.Errorf("token %q was accepted", tok)
		}
	}
}

func TestScopes_sameValueForBothTokensIsWrite(t *testing.T) {
	s := scopedServer(t)
	s.ReadToken = s.Token
	if got, ok := s.scopeOf(s.Token); !ok || got != scopeWrite {
		t.Fatalf("scope %s ok %v", got, ok)
	}
}

func TestOverview_reportsScope(t *testing.T) {
	s := scopedServer(t)
	ts := httptest.NewServer(s.Routes())
	t.Cleanup(ts.Close)
	for tok, want := range map[string]string{"read-tok": "read", "write-tok": "write"} {
		resp, err := http.DefaultClient.Do(requestFor(t, ts.URL, "GET /api/v1/overview", tok))
		if err != nil {
			t.Fatal(err)
		}
		var body struct {
			Scope     string `json:"scope"`
			Interface string `json:"wireguard_interface"`
		}
		err = json.NewDecoder(resp.Body).Decode(&body)
		resp.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != http.StatusOK || body.Scope != want {
			t.Errorf("token %s: status %d scope %q, want %q", tok, resp.StatusCode, body.Scope, want)
		}
		if body.Interface == "" {
			t.Errorf("token %s: the overview fields are gone", tok)
		}
	}
}
