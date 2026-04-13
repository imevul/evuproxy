# Security and privacy

Operational notes for operating EvuProxy safely. The HTTP API reference is in [Local HTTP API](http-api.md).

## Privacy and telemetry

- **No project telemetry:** EvuProxy does not phone home or report usage to the authors. Outbound connections are **operational only** (e.g. GeoIP zone downloads to IPDeny or your configured source, HTTPS for install scripts if you use them).
- **Logs and stats:** **`GET /logs`** returns recent firewall-related journal lines (may include source/destination IPs). **`GET /stats`** and **`GET /metrics`** expose WireGuard and nftables-derived data (keys, endpoints, counters). Treat API responses and host logs as **sensitive** in multi-tenant or shared-log environments.
- **Structured file logs:** With **`EVUPROXY_LOG_DIR`**, **`evuproxy serve`** writes JSON lines under that directory (e.g. **`/var/log/evuproxy/evuproxy.jsonl`**). Forward these to your SIEM with Vector, Fluent Bit, or rsyslog. Do not log API tokens or private keys; keep log files root-readable.
- **Audit events:** **`state/events.jsonl`** records high-level apply/config events (no full config bodies). Same confidentiality as host audit logs.
- **Geo fetches:** Zone downloads are made from the **server’s public IP** (or the egress used for HTTPS). See [Third-party data](third-party-data.md) for IPDeny terms.

## Security roadmap (scoped access)

**Deferred:** separate read vs write API tokens, CSRF hardening beyond bearer tokens, and a strict **Content-Security-Policy** for the static UI are not implemented yet. The UI stores the API token in **sessionStorage/localStorage** when the operator saves it; anyone with script access to the UI origin can read it. Prefer serving the UI and API only on trusted networks, SSH tunnels, and explicit CORS origins instead of `*` when exposed beyond localhost.

## Operational security notes

- After `reload`, nftables **INPUT** is restrictive; the example seed allows **TCP 22**, **80/443**, and **9080** (Docker UI) via **`input_allows`**. Remove **9080** there if you only use SSH tunnels to the UI.
- Do not expose the API on `0.0.0.0` without TLS and strong auth.
- Geo data is approximate; VPN users bypass country filters.
- If geo sets are **empty** while geo is enabled, traffic may be blocked — check `journalctl` and run `evuproxy update-geo`.
- **Reload diagnostics:** `nft delete table` before replace may fail when tables were never loaded (first install); that is expected. Enable **debug** logging to see those lines. Geo zone / loader warnings during reload are logged at **WARN**; fix by running **`evuproxy update-geo`** or fixing zone files.
