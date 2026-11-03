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

**Deferred:** separate read vs write API tokens and CSRF hardening beyond bearer tokens are not implemented yet. The UI stores the API token in **sessionStorage/localStorage** when the operator saves it; anyone with script access to the UI origin can read it. Prefer serving the UI and API only on trusted networks, SSH tunnels, and explicit CORS origins instead of `*` when exposed beyond localhost. **`evuproxy serve` warns** when the API bind is not loopback and `--cors-origins` is `*`.

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

## Operational security notes

- After `reload`, nftables **INPUT** is restrictive; the example seed allows **TCP 22**, **80/443**, and **9080** (Docker UI) via **`input_allows`**. Remove **9080** there if you only use SSH tunnels to the UI.
- Do not expose the API on `0.0.0.0` without TLS and strong auth.
- Geo data is approximate; VPN users bypass country filters.
- Geo enforcement is **fail-closed on apply**: `reload` folds table replacement and geo set population into one atomic nftables transaction, and a missing/invalid zone file aborts the reload before the kernel is touched (fix zone files or run **`evuproxy update-geo`**, then reload again). Geo sets are never live-but-empty after a successful apply.
- **Reload diagnostics:** `nft delete table` inside the generated transaction is a no-op-equivalent when tables were never loaded (first install); that is expected.
