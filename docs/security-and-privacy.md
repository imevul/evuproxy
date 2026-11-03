# Security and privacy

Operational notes for operating EvuProxy safely. The HTTP API reference is in [Local HTTP API](http-api.md).

## Privacy and telemetry

- **No project telemetry:** EvuProxy does not phone home or report usage to the authors. Outbound connections are **operational only** (e.g. GeoIP zone downloads to IPDeny or your configured source, HTTPS for install scripts if you use them).
- **Logs and stats:** **`GET /logs`** returns recent firewall-related journal lines (may include source/destination IPs). **`GET /stats`** and authenticated **`GET /api/v1/metrics`** expose WireGuard and nftables-derived data (keys, endpoints, counters). Treat API responses and host logs as **sensitive** in multi-tenant or shared-log environments.
- **Prometheus (optional):** When enabled via **`--metrics-listen`** (loopback only by default), **`GET /metrics`** on that separate port has **no authentication** and exposes coarse host metrics (apply counters from **`apply-metrics.json`**, maintenance mode, peer online count), plus accepted traffic per route, labelled with each route's **name**. Do not bind to non-loopback without **`--metrics-listen-insecure`** and a firewall.
- **Structured file logs:** With **`EVUPROXY_LOG_DIR`**, **`evuproxy serve`** writes JSON lines under that directory (e.g. **`/var/log/evuproxy/evuproxy.jsonl`**). Forward these to your SIEM with Vector, Fluent Bit, or rsyslog. Do not log API tokens or private keys; keep log files root-readable.
- **Audit events:** **`state/events.jsonl`** records high-level apply/config events (no full config bodies). Same confidentiality as host audit logs.
- **Geo fetches:** Zone downloads are made from the **server’s public IP** (or the egress used for HTTPS). See [Third-party data](third-party-data.md) for IPDeny terms.

## Security roadmap (scoped access)

**Deferred:** separate read vs write API tokens are not implemented yet. The UI stores the API token in **sessionStorage/localStorage** when the operator saves it; anyone with script access to the UI origin can read it. Prefer serving the UI and API only on trusted networks, SSH tunnels, and explicit CORS origins instead of `*` when exposed beyond localhost. **`evuproxy serve` warns** when the API bind is not loopback and `--cors-origins` is `*`.

## Content-Security-Policy

The UI's nginx sends a **Content-Security-Policy** header on the UI and on proxied API responses (`docker/nginx.conf`, with the same policy in `docker/nginx.dev.conf`). If you put another reverse proxy in front, make sure it passes the header through.

| Directive | Value | Why |
|-----------|-------|-----|
| `default-src` | `'none'` | Anything not listed below is refused |
| `script-src` | `'self'` | Only the UI's own files. Injected `<script>` tags, `on*=` attributes and `eval` do not run |
| `style-src` | `'self' https://fonts.googleapis.com` | The UI's stylesheets and the Google Fonts stylesheet. Inline `<style>` and `style=` attributes are refused |
| `font-src` | `https://fonts.gstatic.com` | Google Fonts files |
| `img-src` | `'self' data: blob:` | The favicon, `data:` icons in the stylesheets, and peer QR codes |
| `connect-src` | `'self' https://api.github.com` plus **`EVUPROXY_UI_CONNECT_SRC`** | The API behind `/api`, and the sidebar's release check |
| `base-uri`, `form-action`, `frame-ancestors` | `'none'` | No `<base>` rewriting, no form posts to another site, no framing |

**Cross-origin API:** if the UI's **API base URL** points at another origin, set **`EVUPROXY_UI_CONNECT_SRC`** to that origin (space-separated exact `http(s)` origins, no wildcards) or the browser blocks the calls. The container refuses to start on any other value. See [Local HTTP API](http-api.md#binding-cors-and-authentication).

**What this does not do:** the policy mainly stops injected markup from running as script. Code that does run on the UI origin can still read the stored token, and it could still send it out by navigating the page elsewhere, which CSP does not restrict, or through `https://api.github.com`, for example by creating a gist with an attacker's credentials. Treat the token as compromised after any suspected script injection.

## Cross-site request forgery (CSRF)

**What the token already covers:** the API reads its token only from the **`Authorization`** or **`X-API-Token`** header, never from a cookie or the query string. A browser does not attach those headers by itself, and another site cannot set them on a request without passing a CORS preflight. On its own, a token-protected API is not open to CSRF.

**What remained:** anything in front of the API that adds credentials automatically brings CSRF back. Examples are a reverse proxy that injects the token behind basic auth, an SSO cookie or a client certificate. A page on another site could then send a plain form or `no-cors` **`POST /api/v1/reload`** through the proxy. It could not read the response, but the reload would run, because the API does not require a JSON `Content-Type`.

**What the API does:** every state-changing request (any method except `GET`, `HEAD` and `OPTIONS`) goes through Go's **`http.CrossOriginProtection`** before routing and token checks. A refused request gets **HTTP 403** with **`error_code: cross_origin_refused`** and a warning in the service log.

| Request | Result |
| ------- | ------ |
| Neither **`Sec-Fetch-Site`** nor **`Origin`** (curl, CI, scripts) | Allowed |
| **`Sec-Fetch-Site: same-origin`** or **`none`** | Allowed |
| Other **`Sec-Fetch-Site`** value (`same-site`, `cross-site`), or no such header and **`Origin`** host differs from **`Host`** | Refused, unless **`Origin`** is listed in **`--cors-origins`** |
| Any origin with **`--cors-origins '*'`** | Allowed: the check is off and **`evuproxy serve`** logs a warning |

**Reverse proxies:** browsers send **`Sec-Fetch-Site`** only to HTTPS and localhost addresses, so a UI on plain HTTP elsewhere (for example `http://192.168.1.10:9080`) relies on comparing **`Origin`** with **`Host`**. A proxy in front of the API must then forward the original **`Host`**, including the port. In nginx, use **`proxy_set_header Host $http_host;`**: **`$host`** drops the port, and the default sends the upstream's name. The bundled UI image does this. If you run an older UI image or your own proxy and saves fail with `cross_origin_refused`, fix the header or add the UI origin to **`--cors-origins`**.

**`--cors-origins` values:** entries must be a plain origin such as `https://ui.example`. Anything else, such as a trailing slash, a path or `null`, is ignored for this check and logged as a warning at startup.

**Not covered:**

- **DNS rebinding:** a rebound hostname looks same-origin to this check, because the browser's **`Origin`** matches the **`Host`** it sends. The API token still has to be supplied, so this matters only behind a token-injecting proxy. Such a proxy should accept only its own hostname, for example with an explicit nginx **`server_name`** and a default server that rejects everything else.
- **Reads:** cross-origin `GET` requests are not refused. They change nothing, and the browser hides the response unless CORS allows that origin.
- **Stolen tokens and script on the UI origin:** the check only stops browsers from sending requests on another origin's behalf. Anyone holding the token can use it from curl, and script running on the UI origin counts as same-origin. See [Security roadmap](#security-roadmap-scoped-access).

## Operational security notes

- After `reload`, nftables **INPUT** is restrictive; the example seed allows **TCP 22**, **80/443**, and **9080** (Docker UI) via **`input_allows`**. Remove **9080** there if you only use SSH tunnels to the UI.
- Do not expose the API on `0.0.0.0` without TLS and strong auth.
- Geo data is approximate; VPN users bypass country filters.
- Geo enforcement is **fail-closed on apply**: `reload` folds table replacement and geo set population into one atomic nftables transaction, and a missing/invalid zone file aborts the reload before the kernel is touched (fix zone files or run **`evuproxy update-geo`**, then reload again). Geo sets are never live-but-empty after a successful apply.
- **Reload diagnostics:** `nft delete table` inside the generated transaction is a no-op-equivalent when tables were never loaded (first install); that is expected.
