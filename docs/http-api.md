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

These endpoints change on-disk config, backups, or live nftables / WireGuard: **`PUT /config`**, **`POST /config/discard`**, **`POST /config/restore-previous-applied`**, **`POST /reload`**, **`POST /update-geo`**, **`POST /backup`**, **`POST /restore`**. Only one runs at a time; a second concurrent request gets **HTTP 503** with a stable error message (no queue). Use retries with backoff on the client.

## Backup and restore paths

**`POST /backup?path=…`** and **`POST /restore?path=…`** only accept absolute paths that resolve under the backup allow directory (default **`/var/backups`**). Override the directory with environment variable **`EVUPROXY_BACKUP_DIR`** (must be absolute). Paths are canonicalized; locations outside the allow tree return **4xx**. Treat the backup directory like sensitive storage: a **local attacker** who can create symlinks there could in theory race the API between path check and `tar` (narrow window); use a dedicated directory with restrictive permissions.

## Endpoints

All paths below are under **`/api/v1`** unless noted.


| Method        | Path                                                            | Purpose                                                                                                                                                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` / `PUT` | `/config`                                                       | Read or replace full config. **`PUT`** accepts JSON, validates, writes **YAML** to disk; **does not** reload WireGuard/nftables until **`POST /reload`**. Does not modify **`config.yaml.bak`** or **`config.yaml.bak.N`**. |
| `POST`        | `/config/discard`                                               | Replace **`config.yaml`** with **`config.yaml.bak`** when they differ (validates `.bak`). **400** if no `.bak`, already in sync, or invalid backup. Does not reload the host. |
| `POST`        | `/config/restore-previous-applied`                              | Replace **`config.yaml`** with the first **`config.yaml.bak.N`** (`N` = 1…5) whose contents differ from **`config.yaml.bak`**. Does not rotate or modify any **`.bak*`** files. **400** if no such history entry or invalid YAML. Does not reload the host. |
| `GET`         | `/pending`                                                      | Compare on-disk config to last successful apply. **`nftables`** is the **generated ruleset text** from the current on-disk config. **`nftables_baseline`** is the contents of **`generated/nftables.nft`** when **`os.ReadFile`** succeeds (typically the ruleset last written by **`POST /reload`**); if the file is missing or unreadable (permissions, I/O), it is an empty string. **`discard_available`**: **`config.yaml.bak`** exists and its raw bytes differ from **`config.yaml`**. **`restore_previous_applied_available`**: **`.bak`** exists and some **`.bak.N`** differs from **`.bak`**. |
| `GET` / `PUT` | `/preferences`                                                   | UI helper fields in **`ui-preferences.json`**: tunnel subnet CIDR, WireGuard endpoint, **`metrics_collection_enabled`** (default false; **`PUT`** is partial merge; legacy **`show_peer_latency`** in JSON is migrated on read). |
| `GET` / `PUT` | `/config/notes`                                                  | Operator scratchpad stored as **`config-notes.txt`** beside **`config.yaml`** (plain text, size-capped). **`PUT`** body: **`{"text":"…"}`**. Emits **`config_notes_saved`** in audit events. Does not reload WireGuard/nftables. |
| `GET`         | `/metrics/peers`                                                | Stored peer ICMP metrics (**SQLite**, maintained by **`evuproxy metrics`**). JSON: **`peers`**, **`collection_disabled`**, **`collected_at_utc`**, **`dashboard`** (`last_ping` / `last_10m` min/avg/max ms). Read-only from API; **`serve --metrics-db`** overrides DB path (default **`metrics.sqlite`** beside `--config`). See **[Metrics peers semantics](#metrics-peers-semantics)**. |
| `POST`        | `/reload`                                                       | Regenerate and apply WireGuard + nftables from config. Also updates **`config.yaml.bak`** / rotation (see [Applying changes](config.md#applying-changes)). |
| `POST`        | `/update-geo`                                                   | Download zones and refresh geo sets in nftables.                                                                                                          |
| `GET`         | `/status`, `/overview`, `/metrics`, `/stats`, `/logs`, `/about` | Diagnostics, config summary, **`/metrics`** text for both **inet evuproxy** forward and input chains (either `nft list` failure → 5xx), host stats, recent firewall-related journal lines, version info. **`/logs`** accepts **`?limit=N`** (default **200**) and is rate-limited to **20 requests/minute per token** (excess → **429** with `error_code: rate_limit`). |
| `POST`        | `/backup?path=…`, `/restore?path=…`                             | Archive or restore under `/etc/evuproxy`. Paths must resolve under **`EVUPROXY_BACKUP_DIR`** (default `/var/backups`). **`backup`** defaults `path` to `/var/backups/evuproxy-config.tgz` if omitted; **`restore`** requires `path`.   |
| `GET`         | `/healthz`                                                      | Plain `ok` (no `/api/v1` prefix, no token).                                                                                                               |
| `GET`         | `/config.yaml`                                                  | Raw **`config.yaml` bytes** from disk (`Content-Disposition: attachment`). Same auth as **`GET /config`**.                                               |
| `GET`         | `/events?limit=`                                                | Recent mutating-operation audit events (JSONL-backed, newest first; default **50**, max **200**). Omit **`limit`** or use **`1`–`200`**; other values return **400** with **`error_code`:** `invalid_limit`. |
| `GET`         | `/geo/summary`                                                  | Per-country zone file stats (CIDR line counts, approximate IPv4 totals) and optional merged **`nft`** set size; short-lived server cache.                  |
| `POST`        | `/routes/test`                                                  | On-demand **TCP/UDP** connect/probe from the host to a route’s **`target_ip`** and port (body: `{"route_index":0,"port":optional}`). Rate-limited.        |
| `POST`        | `/validate`                                                     | Dry-run: validate config, generate nftables + WireGuard artifacts, run **`nft -c`**; **no** apply and **no** `.bak` changes. Optional JSON body = draft config (not persisted). Response: `{ok, errors?, warnings?, detected_client_ip, ip_detection_source, ip_detection_note?, validated_from_draft?}`. |
| `GET`         | `/client-ip`                                                    | Operator IPv4 detection for lockout warnings (same logic as validate). |
| `POST`        | `/peers/{index}/qr.png`                                         | PNG QR code of WireGuard client config text (plain-text body, max 16 KiB). Auth required. |
| `POST`        | `/peers/generate-keypair`                                       | Generate a WireGuard keypair when the admin UI cannot use Web Crypto (plain HTTP). Returns `{private_key, public_key}` (base64). Auth required. Prefer HTTPS or localhost so keys stay in the browser when possible. |
| `POST`        | `/peers/onboard-bundle`                                         | Build an **EVUB** onboarding blob (JSON body: `passphrase`, `peer_private_key`, `peer_tunnel_address`, `server_public_key`, `endpoint`, `allowed_ips`, optional `interface_name`). Returns `{blob_base64}`. Same HTTP caveat as keypair generation. |


**`PUT /api/v1/config`** replaces the file with marshalled YAML from the known struct; **comments and unknown keys** in the previous file are **not** preserved.

Validation failures may return **`error_code`** (e.g. **`route_port_overlap`**) with HTTP **400** in addition to **`error`**.

**`GET /api/v1/overview`** may include **`geo_last_success_utc`** and **`geo_last_success_source`** after a successful geo loader run.

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

Mutations append JSON lines under **`/etc/evuproxy/state/events.jsonl`** (config-adjacent **`state/`** directory). Size is capped (**default 2 MiB**; override **`EVUPROXY_EVENTS_MAX_BYTES`**, clamped **256 KiB–8 MiB**). Only one **`evuproxy serve`** process should write this file unless you add external locking.

**`POST /api/v1/config/discard`** and **`POST /api/v1/config/restore-previous-applied`** match **`evuproxy discard-pending`** and **`evuproxy restore-previous-applied`** (see [Applying changes](config.md#applying-changes)).
