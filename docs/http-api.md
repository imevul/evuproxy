# Local HTTP API

`evuproxy serve` exposes a JSON API for automation and the admin UI. For privacy, telemetry, and token storage, see [Security and privacy](security-and-privacy.md). GeoIP data source and attribution: [Third-party data](third-party-data.md).

## Install script and optional API enable

[VPS install](../scripts/install.sh) always installs the **`evuproxy-api.service`** unit under `/etc/systemd/system/` together with the other EvuProxy units. Whether that unit is **enabled** at install time is optional.

### Default / installer behavior

- **Bind:** the packaged unit runs `evuproxy serve` on **`127.0.0.1:9847`** (see [`templates/evuproxy-api.service`](../templates/evuproxy-api.service)). Override by editing the unit or a drop-in.
- **Token file:** `/etc/evuproxy/api.token` is created by the installer if missing (mode `0600`). The API uses **`--token-file`** pointing at that path.
- **Interactive install (TTY):** the script asks whether to **enable** the HTTP API at boot. The **`evuproxy-api.service`** unit file is always installed; only **`systemctl enable`** is optional. Default is **yes** (same as previous behavior if you press Enter). Answers **`y`**, **`yes`**, or Enter mean enable; **`n`** or **`no`** mean do not enable.
- **`EVUPROXY_INSTALL_API`:** if this variable is **set** in the environment (including when stdin **is** a TTY), it **overrides** the prompt. Use **`0`**, **`false`**, **`no`**, or **`off`** (case-insensitive) to skip enabling; any other value enables. If **unset** and stdin is **not** a TTY, the default is **do not enable** — set **`EVUPROXY_INSTALL_API=1`** (or any non-off value) in automation when you want the API at boot.
- **Enable later:** if the unit was not enabled, after `systemctl daemon-reload` run:
  ```bash
  systemctl enable --now evuproxy-api.service
  ```

## Manual non-privileged service (advanced)

The installer runs the API as **root** when enabled (full functionality). If you want the service to run under a **dedicated unprivileged account**, you must configure that yourself; the installer does **not** create users, groups, or permission changes for this.

1. **Create a system user** (example name; pick your own), e.g.:
   ```bash
   useradd -r -s /usr/sbin/nologin -d /nonexistent evuproxy-api
   ```
   Use your distribution’s equivalent if `useradd` differs.

2. **Override the unit** with `systemctl edit evuproxy-api.service` and set at least:
   - **`User=`** and **`Group=`** to that account.

   Verify with **`systemctl cat evuproxy-api.service`** and **`systemctl show -p User,Group evuproxy-api.service`**.

3. **Filesystem access:** the process must read (and for a full admin experience, possibly write) files under **`/etc/evuproxy`**. Typical patterns:
   - A dedicated Unix group (e.g. **`evuproxy`**) with **`chgrp`** / **`chmod`** on **`config.yaml`** and other paths the binary must read.
   - Keep **`wg-private.key`** and similar material at **`0600` root** unless you explicitly accept the security tradeoff of letting the API user read them (needed only if your workflows require exposing key material through the API/UI).
   - Alternatively, use **ACLs** (`setfacl`) on specific files instead of broad group permissions—tune to your threat model.

4. **Journal (optional):** if you need endpoints that read systemd logs, you may need to add the service user to **`systemd-journal`** where your distro exposes that group; membership and behavior vary by distribution.

5. **Capabilities:** some deployments grant **`CAP_NET_ADMIN`** (via systemd `AmbientCapabilities=` / `CapabilityBoundingSet=`) or use a **privileged helper** so a non-root process can affect networking. That is a **major security decision** for a long-lived HTTP service and is **not** automated or endorsed here—consult your distribution and operational requirements.

## Limitations if running as non-root

- **nftables / WireGuard:** applying reloads, updating rules, or changing interfaces usually requires privileges the unprivileged user does not have. Mutating API routes (**`POST /reload`**, **`POST /update-geo`**, etc.) may fail or return errors unless you provide a separate privileged path.
- **Config and secrets:** read-only or partial access can break the web UI or API responses; write access to **`config.yaml`** may require loosening permissions with corresponding security implications.
- **Host introspection:** **`journalctl`**, **`dmesg`**, metrics under **`/proc`**, or backup paths under **`/var/backups`** may be denied or incomplete for a non-root service user.
- **Support:** behavior depends on kernel, systemd, and how much you relaxed permissions; treat this setup as **self-managed** / best-effort.

## Binding, CORS, and authentication

- **Default bind:** `127.0.0.1:9847` — override with `evuproxy serve --listen`. Token: environment variable **`EVUPROXY_API_TOKEN`** or **`evuproxy serve --token-file`** (default `/etc/evuproxy/api.token`).
- **GeoLite2 (log flags):** Optional **`EVUPROXY_GEOLITE_MMDB`** path to a Country **`.mmdb`** file. If the file cannot be opened, **`evuproxy serve`** writes an explanation to **stderr** (see **`journalctl -u evuproxy-api`**) and starts without **`line_geo`** on **`GET /api/v1/logs`**. Details: [Third-party data](third-party-data.md).
- **Cross-origin UI:** If the admin UI is opened from another origin (different scheme/host/port than the API), the browser needs CORS. Enable with **`evuproxy serve --cors-origins`**: a comma-separated list of exact `Origin` values (for example `https://myui.example.com,http://10.0.0.2:9080`), or `*` to allow any origin. The API remains protected by the bearer token; prefer an explicit list over `*` when the API is reachable from untrusted networks. With `*`, any website the operator opens could send credentialed requests if the token is stored in the UI — keep the API on localhost or use an explicit origin list when the browser can load untrusted pages. **`evuproxy serve` logs a warning** when the API bind is not loopback and CORS is `*`.
- **No DNS name required:** The API often runs on **`127.0.0.1:9847`** without a hostname. For cross-origin UI, list the **exact browser Origin** (scheme + host + port), e.g. `http://127.0.0.1:9080` or `http://192.168.1.10:9080`. Same-origin setups (UI and API behind one reverse proxy, or UI opened via SSH tunnel to the API host) do not need CORS.
- **QR codes and CORS:** **`POST /api/v1/peers/{index}/qr.png`** sends the WireGuard config in the POST body (not the query string). The global CORS middleware answers **OPTIONS** preflight for allowed origins, so cross-origin QR works when `--cors-origins` includes your UI origin.
- **Auth:** `Authorization: Bearer …` or `X-API-Token` on `/api/v1/*` routes. **`GET /healthz`** is unauthenticated (for probes). **Reverse proxies** should not log `Authorization` or `X-API-Token` values (redact or omit these headers in access logs).

## Mutating operations (serialization)

These endpoints change on-disk config, backups, or live nftables / WireGuard: **`PUT /config`**, **`POST /config/discard`**, **`POST /config/restore-previous-applied`**, **`POST /reload`**, **`POST /apply/confirm`**, **`POST /apply/revert`**, **`POST /apply/reverted/restore`**, **`POST /apply/reverted/dismiss`**, **`POST /update-geo`**, **`POST /backup`**, **`POST /restore`**. Only one runs at a time; a second concurrent request gets **HTTP 503** with a stable error message (no queue). Use retries with backoff on the client.

## Backup and restore paths

**`POST /backup?path=…`** and **`POST /restore?path=…`** only accept absolute paths that resolve under the backup allow directory (default **`/var/backups`**). Override the directory with environment variable **`EVUPROXY_BACKUP_DIR`** (must be absolute). Paths are canonicalized; locations outside the allow tree return **4xx**. Treat the backup directory like sensitive storage: a **local attacker** who can create symlinks there could in theory race the API between path check and `tar` (narrow window); use a dedicated directory with restrictive permissions.

## Endpoints

All paths below are under **`/api/v1`** unless noted.


| Method        | Path                                                            | Purpose                                                                                                                                                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` / `PUT` | `/config`                                                       | Read or replace full config. **`PUT`** accepts JSON, validates, writes **YAML** to disk; **does not** reload WireGuard/nftables until **`POST /reload`**. Does not modify **`config.yaml.bak`** or **`config.yaml.bak.N`**. **`GET`** returns an **`ETag`**; **`PUT`** accepts **`If-Match`** and answers **409** on a stale revision (see [Config revisions](#config-revisions-etag--if-match)). |
| `POST`        | `/config/discard`                                               | Replace **`config.yaml`** with **`config.yaml.bak`** when they differ (validates `.bak`). **400** if no `.bak`, already in sync, or invalid backup. Does not reload the host. |
| `POST`        | `/config/restore-previous-applied`                              | Replace **`config.yaml`** with the first **`config.yaml.bak.N`** (`N` = 1…5) whose contents differ from **`config.yaml.bak`**. Does not rotate or modify any **`.bak*`** files. **400** if no such history entry or invalid YAML. Does not reload the host. |
| `GET`         | `/pending`                                                      | Compare on-disk config to last successful apply. **`nftables`** is the **generated ruleset text** from the current on-disk config. **`nftables_baseline`** is the contents of **`generated/nftables.nft`** when **`os.ReadFile`** succeeds (typically the ruleset last written by **`POST /reload`**); if the file is missing or unreadable (permissions, I/O), it is an empty string. **`discard_available`**: **`config.yaml.bak`** exists and its raw bytes differ from **`config.yaml`**. **`restore_previous_applied_available`**: **`.bak`** exists and some **`.bak.N`** differs from **`.bak`**. **`discard_change_count`** and **`restore_previous_change_count`**: how many list rows and other values each of those actions would change in **`config.yaml`** (comments, key order and row order do not count); **`0`** when not available or not computable. **`applied_config`**: the last applied config (**`config.yaml.bak`**) in the same shape as **`GET /config`**, for comparing with the saved config. **`null`** when **`.bak`** is missing or no longer loads, or when its hash differs from **`applied_config_sha256`** (it is then not known to be what the host is running). |
| `GET` / `PUT` | `/preferences`                                                   | UI helper fields in **`ui-preferences.json`**: tunnel subnet CIDR, WireGuard endpoint, **`metrics_collection_enabled`** (default false; **`PUT`** is partial merge; legacy **`show_peer_latency`** in JSON is migrated on read). |
| `GET` / `PUT` | `/config/notes`                                                  | Operator scratchpad stored as **`config-notes.txt`** beside **`config.yaml`** (plain text, size-capped). **`PUT`** body: **`{"text":"…"}`**. Emits **`config_notes_saved`** in audit events. Does not reload WireGuard/nftables. |
| `GET`         | `/metrics/peers`                                                | Stored peer ICMP metrics (**SQLite**, maintained by **`evuproxy metrics`**). JSON: **`peers`**, **`collection_disabled`**, **`collected_at_utc`**, **`dashboard`** (`last_ping` / `last_10m` min/avg/max ms). Read-only from API; **`serve --metrics-db`** overrides DB path (default **`metrics.sqlite`** beside `--config`). See **[Metrics peers semantics](#metrics-peers-semantics)**. |
| `POST`        | `/reload`                                                       | Regenerate and apply WireGuard + nftables from config. Also updates **`config.yaml.bak`** / rotation (see [Applying changes](config.md#applying-changes)). One-way unless the body asks otherwise; see [Confirm or revert](#confirm-or-revert). |
| `GET`         | `/apply/session`                                                | Whether an Apply is waiting for confirmation, and the last revert. See [Confirm or revert](#confirm-or-revert). |
| `POST`        | `/apply/confirm`, `/apply/revert`                               | Keep the waiting Apply, or revert it now. **`/apply/revert`** also retries a revert that failed. |
| `POST`        | `/apply/reverted/restore`, `/apply/reverted/dismiss`            | Bring the rejected config back as unapplied changes, or forget it. |
| `GET`         | `/reload/progress`                                              | Stage of the **`POST /reload`** running in this API process, which answers only when it has finished: **`step`** is **`firewall`**, **`wireguard`**, or an empty string when none is running. Does not see a reload run by the CLI. |
| `POST`        | `/update-geo`                                                   | Download zones and refresh geo sets in nftables. With [confirm mode](config.md#confirm-or-revert-apply) on it refreshes the last applied config's sets, and **`geo_changes_held_back`** in the answer is **`true`** when **`config.yaml`** has geo set changes that it left for the next Apply. **409** with **`apply_session_active`** while a confirm session exists. |
| `GET`         | `/status`, `/overview`, `/metrics`, `/stats`, `/logs`, `/about` | Diagnostics, config summary, **`/metrics`** text for both **inet evuproxy** forward and input chains (either `nft list` failure → 5xx), host stats, recent firewall-related journal lines, version info. **`/logs`** accepts **`?limit=N`** (default **200**) and is rate-limited to **20 requests/minute per token** (excess → **429** with `error_code: rate_limit`). |
| `GET`         | `/diagnostics.md`                                               | Markdown **host support bundle** (`Content-Disposition: attachment`). Collects WireGuard, routes, sockets, networkd drop-ins, unit/kernel logs, nftables snapshot, sanitized config, version + best-effort UI Docker OCI labels. Secrets redacted (no API token / private keys); public IPs and peer public keys may still appear. Rate-limited (**10**/minute per token → **429** `rate_limit`). CLI: **`evuproxy diagnostics`**. |
| `POST`        | `/backup?path=…`, `/restore?path=…`                             | Archive or restore under `/etc/evuproxy`. Paths must resolve under **`EVUPROXY_BACKUP_DIR`** (default `/var/backups`). **`backup`** defaults `path` to `/var/backups/evuproxy-config.tgz` if omitted; **`restore`** requires `path`.   |
| `GET`         | `/backup/info?path=…`                                           | **`archive`**, **`modified`** (RFC 3339, UTC) and **`size_bytes`** of an archive, under the same path rules. **404** if there is no such file. |
| `GET`         | `/healthz`                                                      | Plain `ok` (no `/api/v1` prefix, no token).                                                                                                               |
| `GET`         | `/config.yaml`                                                  | Raw **`config.yaml` bytes** from disk (`Content-Disposition: attachment`). Same auth as **`GET /config`**.                                               |
| `GET`         | `/events?limit=`                                                | Recent mutating-operation audit events (JSONL-backed, newest first; default **50**, max **200**). Omit **`limit`** or use **`1`–`200`**; other values return **400** with **`error_code`:** `invalid_limit`. |
| `GET`         | `/geo/summary`                                                  | Per-country zone file stats (CIDR line counts, approximate IPv4 totals) and optional merged **`nft`** set size; short-lived server cache.                  |
| `POST`        | `/geo/check-ip`                                                 | Dry-run: would this source IPv4 be allowed or blocked by geoblocking / global denylist / break-glass? Body: **`{"ip":"…"}`** plus optional **`config`** draft (same shape as **`PUT /config`**; not persisted). Uses on-disk zone files and optional GeoLite2 — does **not** probe live nftables. Rate-limited (**30**/minute per token → **429** `rate_limit`). Response: **`{ok, ip, verdict, summary, …}`** with **`verdict`** one of **`allowed`**, **`blocked`**, **`geo_off`**, **`uncertain`** (not enough zone/GeoLite2 evidence), **`invalid`**. |
| `POST`        | `/routes/test`                                                  | On-demand **TCP/UDP** connect/probe from the host to a route’s **`target_ip`** and port (body: `{"route_index":0,"port":optional}`). Rate-limited.        |
| `POST`        | `/validate`                                                     | Dry-run: validate config, generate nftables + WireGuard artifacts, run **`nft -c`**; **no** apply and **no** `.bak` changes. Optional JSON body = draft config (not persisted). Response: `{ok, errors?, warnings?, detected_client_ip, ip_detection_source, ip_detection_note?, validated_from_draft?}`. |
| `GET`         | `/client-ip`                                                    | Operator IPv4 detection for lockout warnings (same logic as validate). |
| `POST`        | `/peers/{index}/qr.png`                                         | PNG QR code of WireGuard client config text (plain-text body, max 16 KiB). Auth required. |
| `POST`        | `/peers/generate-keypair`                                       | Generate a WireGuard keypair when the admin UI cannot use Web Crypto (plain HTTP). Returns `{private_key, public_key}` (base64). Auth required. Prefer HTTPS or localhost so keys stay in the browser when possible. |
| `POST`        | `/peers/onboard-bundle`                                         | Build an **EVUB** onboarding blob (JSON body: `passphrase`, `peer_private_key`, `peer_tunnel_address`, `server_public_key`, `endpoint`, `allowed_ips`, optional `interface_name`). Returns `{blob_base64}`. Same HTTP caveat as keypair generation. |


**`POST /validate` lockout risks:** warnings whose **`code`** starts with **`lockout_risk_`** must be acknowledged in the UI before a one-way Apply. With [confirm or revert](#confirm-or-revert) on, the UI shows them through the countdown and asks for no acknowledgement. Nothing on the server refuses the reload.

| Code | Meaning |
|------|---------|
| `lockout_risk_maintenance` | Maintenance mode is on, so public port forwards are omitted. |
| `lockout_risk_source_deny` | The client address is in the global or a route's forward denylist. |
| `lockout_risk_source_allow` | A route's allowlist does not include the client address. |
| `lockout_risk_geo` | Geoblocking may block the client address on a route. |
| `lockout_risk_input_allows` | The last applied config (`config.yaml.bak`) accepts TCP port 22 (SSH), 9080 (admin UI) or the port of the current connection, and this config does not, through either an enabled **`input_allows`** rule or **`network.admin_tcp_ports`**. One warning per port. With no readable snapshot, every one of those ports without a rule warns. The connection port comes from **`X-Forwarded-Port`** (set by the UI nginx), otherwise from the API's own socket, and loopback sockets are ignored. SSH on another port or a custom UI port is only caught when it is the current connection. |
| `lockout_risk_check_unavailable` | The client IPv4 address could not be detected, so the address-specific checks did not run. |

**`PUT /api/v1/config`** replaces the file with marshalled YAML from the known struct; **comments and unknown keys** in the previous file are **not** preserved.

### Confirm or revert

**`POST /reload`** with **`{"confirm_timeout_seconds": 60}`** (**10** to **3600**) applies the config and reverts it unless **`POST /apply/confirm`** arrives in time. A systemd timer does the revert, so it happens even with the API stopped. Behavior, the **`apply`** config setting and the matching CLI commands are in [Confirm or revert](config.md#confirm-or-revert-apply).

**Existing callers are unaffected.** With no body, or a body that isn't a JSON object, **`POST /reload`** stays one-way, whatever the **`apply`** setting says. The setting only tells the web UI what to send. The one difference is during a confirmation window, when a one-way reload gets **409**.

The response to a confirmed reload adds **`session`**, in the same shape as below.

**`GET /apply/session`**:

```json
{
  "confirm_enabled": true,
  "confirm_timeout_seconds": 60,
  "session": {
    "phase": "active",
    "started_at": "2026-11-02T08:00:00Z",
    "deadline": "2026-11-02T08:01:02Z",
    "timeout_seconds": 60,
    "remaining_seconds": 41
  },
  "last_revert": null
}
```

- **`confirm_enabled`**, **`confirm_timeout_seconds`**: the **`apply`** setting in **`config.yaml`**.
- **`session`**: **`null`** when nothing is waiting. **`phase`** is **`active`**, **`rolling_back`**, or **`failed`** with a **`failure`** message; **`failed`** also covers a session past its deadline whose timer ended without reverting, and a revert that was killed before it finished. Prefer **`remaining_seconds`** to **`deadline`** for a countdown, since clocks differ.
- **`last_revert`**: **`{at, reason, config_available}`** until it is dismissed or a new session starts. **`reason`** is **`timeout`**, **`manual`**, **`interrupted`** (the session outlived its timer, usually a reboot), or **`failed_apply`** (an Apply failed and so did its revert, then a reboot, API restart or **`evuproxy reload`** finished the revert). **`config_available`** says **`config.yaml.reverted`** exists.

Refusals answer **409** with a stable **`error_code`**:

| `error_code` | Meaning |
|--------------|---------|
| `apply_session_active` | One-way **`POST /reload`** or **`POST /restore`** during a window, or restoring a rejected config while a session exists. |
| `no_apply_session` | Nothing to confirm or revert. A timer may have got there first; read **`GET /apply/session`**. |
| `rollback_failed` | A revert failed and still stands, so this was refused. Retry **`POST /apply/revert`**. Also returned when an Apply failed and reverting it failed too. |
| `no_baseline` | No known-good config to revert to: **`config.yaml.bak`** is missing, invalid, or not what was last applied. Run a one-way reload first. |
| `confirm_unavailable` | The timer could not be armed (no systemd, or an API that isn't root). Nothing was changed. |
| `no_reverted_config`, `pending_edits` | **`POST /apply/reverted/restore`** has nothing to restore, or **`config.yaml`** has unapplied changes it won't replace. |

An invalid **`POST /reload`** body, such as a timeout out of range, answers **400** with **`error_code`:** `invalid_reload_body`. The audit events add **`apply_confirmed`**, **`apply_reverted`** (detail: the reason, or **`failed_apply`** when a failed Apply put the host back) and **`apply_revert_failed`**.

### Config revisions (`ETag` / `If-Match`)

**`PUT /config`** replaces the whole file, so a client holding an old copy would revert everything saved since it read it. Send a revision to detect that:

- **`GET /config`** returns the current revision in the **`ETag`** response header (a quoted SHA-256 of **`config.yaml`**). The body is unchanged, so it can still be sent back as the **`PUT`** body. A successful **`PUT`** returns the new revision the same way.
- **`PUT /config`** with **`If-Match: "<revision>"`** saves only if the file still has that revision. Otherwise it writes nothing and answers **HTTP 409** with **`error_code`:** `config_revision_mismatch`. Fetch the config again, reapply your change, and retry. The check runs before validation, so a stale draft gets **409** rather than **400**.
- **`PUT /config`** with **no `If-Match`** (or **`If-Match: *`**) is an **unconditional save**: last write wins, exactly as before revisions existed. Existing scripts and automation keep working, but can overwrite concurrent changes, so send **`If-Match`** when other clients may be editing. A header that is present but names no revision gets **409**.

Revisions hash the file, so anything that changes it moves the revision: **`evuproxy`** CLI commands, hand edits, **`POST /config/discard`**, **`POST /config/restore-previous-applied`**, **`POST /restore`**. **`POST /reload`** does not change it. Saving identical content produces the same revision.

```bash
etag=$(curl -sS -D - -o config.json -H "X-API-Token: $TOKEN" http://127.0.0.1:9847/api/v1/config | awk 'tolower($1)=="etag:" {print $2}' | tr -d '\r')
# ...edit config.json...
curl -sS -X PUT -H "X-API-Token: $TOKEN" -H "If-Match: $etag" -d @config.json http://127.0.0.1:9847/api/v1/config
```

The admin UI always sends **`If-Match`**. On **409** it reapplies the single edit (a switch, a row Remove, one form) to the fresh config and retries. If that edit no longer applies, for example because the same row changed elsewhere, it says so and leaves your input in place. With **`--cors-origins`**, **`If-Match`** is an allowed request header and **`ETag`** is exposed to the browser.

Validation failures may return **`error_code`** (e.g. **`route_port_overlap`**, **`route_target_peer_disabled`**, or **`config_invalid`**) with HTTP **400** in addition to **`error`**. **`route_target_peer_disabled`** means an enabled route’s `target_ip` does not match any non-disabled peer (common when disabling a peer that still has forwards).

**`GET /api/v1/overview`** may include **`geo_last_success_utc`** and **`geo_last_success_source`** after a successful geo loader run, and **`host_warnings`** (array of `{code, message}`) when live WireGuard host checks fail — e.g. tunnel address missing after systemd-networkd wipe, or **`wg_endpoint_host_mismatch`** when Settings’ WireGuard server endpoint DNS does not match this host’s public IPs (Cloudflare orange-cloud footgun — see [config.md](config.md#wireguard-server-endpoint-ui-preferences)).

### Metrics peers semantics

**`collected_at_utc`** is the newest **`ts_utc`** among **`peer_latest`** rows that parse as RFC3339 (written by the collector). If **`evuproxy metrics`** is idle, stopped, or nothing was written yet, this may be empty or lag behind wall clock.

**`dashboard.last_10m`**, when present, aggregates **ok** samples from **`peer_sample`** over a **rolling ten minutes ending at request time** (`window_end_utc` / `window_start_utc`). Because the window is anchored to the API request, **`window_end_utc`** is often **newer** than **`collected_at_utc`** when the collector has been idle. If there are no samples in the window, **`last_10m`** may be omitted.

**`dashboard.ping_history`** (optional) lists **approx. one‑minute buckets** of **average latency across peers** from **`peer_sample`** for about the **last fifteen minutes**, for simple Overview charts.

## Prometheus metrics (optional)

Host metrics are exposed on a **separate HTTP listener** from the JSON API. **Disabled by default.**

- Enable: `evuproxy serve --metrics-listen 127.0.0.1:9848` or environment variable **`EVUPROXY_METRICS_LISTEN`**.
- Endpoint: **`GET /metrics`** (Prometheus text exposition). **No authentication** — must bind to loopback (`127.0.0.1`, `::1`, or `localhost`). Non-loopback addresses are **rejected** unless you also pass **`--metrics-listen-insecure`** (not recommended).
- Metrics include: `evuproxy_apply_success_total`, `evuproxy_apply_failure_total`, `evuproxy_geo_last_success_timestamp_seconds`, `evuproxy_peers_online`, `evuproxy_maintenance_mode`.

Example scrape config:

```yaml
scrape_configs:
  - job_name: evuproxy
    static_configs:
      - targets: ["127.0.0.1:9848"]
```

## File logging (`evuproxy serve`)

When **`EVUPROXY_LOG_DIR`** is set (e.g. **`/var/log/evuproxy`**), **`evuproxy serve`** writes **JSON lines** to **`$EVUPROXY_LOG_DIR/evuproxy.jsonl`** in addition to **stderr** (journald). Unset in development to skip file logging. See [contrib/logrotate.d/evuproxy](../contrib/logrotate.d/evuproxy) for rotation notes.

**`EVUPROXY_TRUST_XFF`:** when set to **`1`**, **`true`**, or **`yes`**, **`GET /client-ip`** and **`POST /validate`** use the first IPv4 hop in **`X-Forwarded-For`**. Default: ignore **`X-Forwarded-For`** and use the connection address only. Enable only behind a trusted reverse proxy.

## Audit events file

Mutations append JSON lines under **`/etc/evuproxy/state/events.jsonl`** (config-adjacent **`state/`** directory). Size is capped (**default 2 MiB**; override **`EVUPROXY_EVENTS_MAX_BYTES`**, clamped **256 KiB–8 MiB**). Only one **`evuproxy serve`** process should write this file unless you add external locking. The one exception is confirm-or-revert, whose events come from whichever process acted, including the revert timer and the CLI, so they appear with the API stopped. A line could be lost if the file is being trimmed at that moment.

**`POST /api/v1/config/discard`** and **`POST /api/v1/config/restore-previous-applied`** match **`evuproxy discard-pending`** and **`evuproxy restore-previous-applied`** (see [Applying changes](config.md#applying-changes)).
