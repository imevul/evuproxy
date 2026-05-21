# Web UI (Docker)

The admin UI is intended to run **in Docker only**. From the repo root:

```bash
docker compose up --build
```

Browse `http://127.0.0.1:9080`. On a remote VPS, use an **SSH tunnel** instead of exposing the UI publicly. The UI container uses **host networking** so nginx can proxy `/api` to **`127.0.0.1:9847`** without binding the API on `0.0.0.0`. Override **`EVUPROXY_UI_LISTEN`** (e.g. `0.0.0.0:9080`) only for temporary LAN tests — the UI then listens on all interfaces; combine with firewall rules and treat the token like a password. **Host network is Linux-oriented**; use the dev mock stack on other setups if needed. Docker Compose defines an optional **`healthcheck`** against **`GET /healthz`** on the UI nginx port.

Production nginx sends **`Cache-Control: no-cache, private, must-revalidate`** for HTML and `/static/*` so a rebuilt UI image is picked up after a normal reload (without relying on hard refresh). Ensure **`evuproxy serve`** on the host is updated when API behavior changes (e.g. new JSON fields); `scripts/update.sh` restarts the API service and rebuilds the UI container when compose is in use.

See also [Security and privacy](security-and-privacy.md) and [Local HTTP API](http-api.md).

The UI is **dark-themed** only. **Overview** shows recent **audit events** (from the API) and geo list freshness when available. **Settings** uses tabs (**Preferences**, **Notes & backups**, **Advanced**) and can download raw **`config.yaml`** from Preferences. **Peers** and **Routes** support a **header search** (press **`/`** to focus). **Routes** include an on-host **Test** probe (TCP/UDP; UDP may be inconclusive). **Geoblocking** lists per-country zone statistics from the API. **Topology** shows a read-only graph of `forwarding.routes` from the EvuProxy host (ingress) to each target peer, using `GET /v1/stats` for WireGuard handshake-style edge coloring.

## Stats page

**WireGuard peers** come from `wg show`. **nftables counters** lists only nft rules that include an explicit **`counter`** keyword (`GET /api/v1/stats` parses `nft list table … -a`).

Generated EvuProxy enforcement drops (geoblock, rate limits, CrowdSec, forward catch-all) use **`log prefix`** and **`drop`** — not **`counter`** — so hit counts show up on the **Logs** page (journal/dmesg), not in the Stats nftables table, even when those features are enabled and dropping traffic.

**Deferred:** add optional **`counter`** on selected drop rules (or dedicated summary rules) so rate-limit and CrowdSec packet counts could also appear on Stats, in addition to log lines on Logs.

**Advanced mode** (Settings) **disables** the **Advanced** tab on **Routes** and **Geoblocking** in this browser (`localStorage`) until turned on — the tab stays visible with a hint linking to Settings. It does not gate **Apply geoblocking to inbound allow rules** — that control stays on the Geoblocking default tab. When only one tab is actionable, the tab control uses subdued styling so the active segment reads as a section label, not a lone button.

## Local UI with mock API

To try the admin UI **without** `evuproxy serve` on the host (no WireGuard or nftables changes), use the dev stack: a stub API in Docker plus the same UI image, wired on the compose network.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://127.0.0.1:9080` and enter API token **`dev`** (default), or set `MOCK_API_TOKEN` when starting compose and use that value in the UI. The mock implements the same HTTP paths and JSON shapes as the real API. **Config persistence (dev):** the mock writes successful `PUT /api/v1/config` (and discard/restore paths that rewrite config) to **`docker/mock-api/state/mock-config.json`** inside a bind-mounted volume so edits survive container restart. Delete that file (or run **`make dev-fresh`** from the repo root) to reset to the Python baseline in **`mock_server.py`**. Synthetic **`GET /api/v1/stats`** `wireguard_peers` fields support the **Topology** page (Animated edges ≈ counter deltas in mock only).

**Live UI edits:** [docker-compose.dev.yml](../docker-compose.dev.yml) bind-mounts [web/](../web/) into the nginx container and [docker/mock-api/mock_server.py](../docker/mock-api/mock_server.py) into the mock container. Edit static files or the mock script on the host, **reload the browser** for UI changes, or run `docker compose -f docker-compose.dev.yml restart mock-api` after Python edits. Rebuild images only when [docker/Dockerfile](../docker/Dockerfile), [docker/nginx.conf](../docker/nginx.conf), or [docker/entrypoint.sh](../docker/entrypoint.sh) change. Dev nginx uses [docker/nginx.dev.conf](../docker/nginx.dev.conf) (`Cache-Control: no-store`, fixed upstream to `mock-api`).

**Playwright snapshots (layout review):** with the mock stack reachable on `127.0.0.1:9080`, from the repo root run **`make playwright-deps`** once then **`make playwright-visual`** ; see [devtools/playwright-visual/README.md](../devtools/playwright-visual/README.md).
