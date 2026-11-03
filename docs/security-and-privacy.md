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

**Deferred:** separate read vs write API tokens, CSRF hardening beyond bearer tokens, and a strict **Content-Security-Policy** for the static UI are not implemented yet. The UI stores the API token in **sessionStorage/localStorage** when the operator saves it; anyone with script access to the UI origin can read it. Prefer serving the UI and API only on trusted networks, SSH tunnels, and explicit CORS origins instead of `*` when exposed beyond localhost. **`evuproxy serve` warns** when the API bind is not loopback and `--cors-origins` is `*`.

## Optional mTLS for the API

By default the API token alone grants full admin access to anyone who can reach the API. For clients that connect from another host, **`evuproxy serve --mtls-listen`** adds a listener that also requires a client certificate, so a leaked token is refused at the TLS handshake and a leaked certificate alone gets **401**. The private key never travels in requests, so it cannot leak through headers, proxy logs, or UI storage. It is off by default; SSH tunnels and trusted networks remain the simpler choice when they fit. Setup steps are in [Local HTTP API](http-api.md#optional-mtls-listener).

What it does not cover:

- **The plain listener:** **`--listen`** still accepts the token alone, so the token is enough for anything that can reach it. Keep it on loopback, or turn it off with **`--listen ""`** if you do not use the admin UI. The UI and anything else on the host or behind an SSH tunnel to that port are not protected by mTLS.
- **A compromised client:** an attacker on a machine holding both the client key and the token has everything needed. Keep the token and client key out of shared storage.
- **Revocation:** there is no CRL or OCSP check. Every unexpired certificate from the CA stays valid, so issue short-lived client certificates. To cut off a lost key sooner, create a new CA, reissue the certificates you still trust, and restart **`serve`**. Rotate the API token too if it may have leaked.
- **CA choice:** use a private CA for this API only, since **`--mtls-client-ca`** accepts everything that CA signs, and all accepted clients have the same access. Keep the CA key off the server if you can: anyone who has it can issue accepted certificates.

## Operational security notes

- After `reload`, nftables **INPUT** is restrictive; the example seed allows **TCP 22**, **80/443**, and **9080** (Docker UI) via **`input_allows`**. Remove **9080** there if you only use SSH tunnels to the UI.
- Do not expose the API on `0.0.0.0` without TLS and strong auth. **`--listen`** is plain HTTP; use the [mTLS listener](#optional-mtls-for-the-api) or a TLS proxy.
- Geo data is approximate; VPN users bypass country filters.
- Geo enforcement is **fail-closed on apply**: `reload` folds table replacement and geo set population into one atomic nftables transaction, and a missing/invalid zone file aborts the reload before the kernel is touched (fix zone files or run **`evuproxy update-geo`**, then reload again). Geo sets are never live-but-empty after a successful apply.
- **Reload diagnostics:** `nft delete table` inside the generated transaction is a no-op-equivalent when tables were never loaded (first install); that is expected.
