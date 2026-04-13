# Local HTTP API

`evuproxy serve` exposes a JSON API for automation and the admin UI. For privacy, telemetry, and token storage, see [Security and privacy](security-and-privacy.md). GeoIP data source and attribution: [Third-party data](third-party-data.md).

## Binding, CORS, and authentication

- **Default bind:** `127.0.0.1:9847` — override with `evuproxy serve --listen`. Token: environment variable **`EVUPROXY_API_TOKEN`** or **`evuproxy serve --token-file`** (default `/etc/evuproxy/api.token`).
- **Cross-origin UI:** If the admin UI is opened from another origin (different scheme/host/port than the API), the browser needs CORS. Enable with **`evuproxy serve --cors-origins`**: a comma-separated list of exact `Origin` values (for example `https://myui.example.com,http://10.0.0.2:9080`), or `*` to allow any origin. The API remains protected by the bearer token; prefer an explicit list over `*` when the API is reachable from untrusted networks. With `*`, any website the operator opens could send credentialed requests if the token is stored in the UI — keep the API on localhost or use an explicit origin list when the browser can load untrusted pages.
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
| `GET` / `PUT` | `/preferences`                                                  | UI helper fields (e.g. tunnel subnet CIDR, WireGuard endpoint for client snippets).                                                                       |
| `POST`        | `/reload`                                                       | Regenerate and apply WireGuard + nftables from config. Also updates **`config.yaml.bak`** / rotation (see [Applying changes](config.md#applying-changes)). |
| `POST`        | `/update-geo`                                                   | Download zones and refresh geo sets in nftables.                                                                                                          |
| `GET`         | `/status`, `/overview`, `/metrics`, `/stats`, `/logs`, `/about` | Diagnostics, config summary, **`/metrics`** text for both **inet evuproxy** forward and input chains (either `nft list` failure → 5xx), host stats, recent firewall-related journal lines, version info.                                             |
| `POST`        | `/backup?path=…`, `/restore?path=…`                             | Archive or restore under `/etc/evuproxy`. Paths must resolve under **`EVUPROXY_BACKUP_DIR`** (default `/var/backups`). **`backup`** defaults `path` to `/var/backups/evuproxy-config.tgz` if omitted; **`restore`** requires `path`.   |
| `GET`         | `/healthz`                                                      | Plain `ok` (no `/api/v1` prefix, no token).                                                                                                               |
| `GET`         | `/config.yaml`                                                  | Raw **`config.yaml` bytes** from disk (`Content-Disposition: attachment`). Same auth as **`GET /config`**.                                               |
| `GET`         | `/events?limit=`                                                | Recent mutating-operation audit events (JSONL-backed, newest first; default **50**, max **200**). Omit **`limit`** or use **`1`–`200`**; other values return **400** with **`error_code`:** `invalid_limit`. |
| `GET`         | `/geo/summary`                                                  | Per-country zone file stats (CIDR line counts, approximate IPv4 totals) and optional merged **`nft`** set size; short-lived server cache.                  |
| `POST`        | `/routes/test`                                                  | On-demand **TCP/UDP** connect/probe from the host to a route’s **`target_ip`** and port (body: `{"route_index":0,"port":optional}`). Rate-limited.        |


**`PUT /api/v1/config`** replaces the file with marshalled YAML from the known struct; **comments and unknown keys** in the previous file are **not** preserved.

Validation failures may return **`error_code`** (e.g. **`route_port_overlap`**) with HTTP **400** in addition to **`error`**.

**`GET /api/v1/overview`** may include **`geo_last_success_utc`** and **`geo_last_success_source`** after a successful geo loader run.

## File logging (`evuproxy serve`)

When **`EVUPROXY_LOG_DIR`** is set (e.g. **`/var/log/evuproxy`**), **`evuproxy serve`** writes **JSON lines** to **`$EVUPROXY_LOG_DIR/evuproxy.jsonl`** in addition to **stderr** (journald). Unset in development to skip file logging. See [contrib/logrotate.d/evuproxy](../contrib/logrotate.d/evuproxy) for rotation notes.

## Audit events file

Mutations append JSON lines under **`/etc/evuproxy/state/events.jsonl`** (config-adjacent **`state/`** directory). Size is capped (**default 2 MiB**; override **`EVUPROXY_EVENTS_MAX_BYTES`**, clamped **256 KiB–8 MiB**). Only one **`evuproxy serve`** process should write this file unless you add external locking.

**`POST /api/v1/config/discard`** and **`POST /api/v1/config/restore-previous-applied`** match **`evuproxy discard-pending`** and **`evuproxy restore-previous-applied`** (see [Applying changes](config.md#applying-changes)).
