# Web UI (Docker)

The admin UI is intended to run **in Docker only**. From the repo root:

```bash
docker compose up --build
```

Browse `http://127.0.0.1:9080`. On a remote VPS, use an **SSH tunnel** instead of exposing the UI publicly. The UI container uses **host networking** so nginx can proxy `/api` to **`127.0.0.1:9847`** without binding the API on `0.0.0.0`. Override **`EVUPROXY_UI_LISTEN`** (e.g. `0.0.0.0:9080`) only for temporary LAN tests — the UI then listens on all interfaces; combine with firewall rules and treat the token like a password. **Host network is Linux-oriented**; use the dev mock stack on other setups if needed. Docker Compose defines an optional **`healthcheck`** against **`GET /healthz`** on the UI nginx port.

Production nginx sends **`Cache-Control: no-cache, private, must-revalidate`** for HTML and `/static/*` so a rebuilt UI image is picked up after a normal reload (without relying on hard refresh). Ensure **`evuproxy serve`** on the host is updated when API behavior changes (e.g. new JSON fields); `scripts/update.sh` restarts the API service and rebuilds the UI container when compose is in use.

See also [Security and privacy](security-and-privacy.md) and [Local HTTP API](http-api.md).

The UI is **dark-themed** only. **Overview** shows recent **audit events** (from the API) and geo list freshness when available. **Settings** can download raw **`config.yaml`**. **Peers** and **Routes** support a **header search** (press **`/`** to focus). **Routes** include an on-host **Test** probe (TCP/UDP; UDP may be inconclusive). **Geoblocking** lists per-country zone statistics from the API.

## Local UI with mock API

To try the admin UI **without** `evuproxy serve` on the host (no WireGuard or nftables changes), use the dev stack: a stub API in Docker plus the same UI image, wired on the compose network.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://127.0.0.1:9080` and enter API token **`dev`** (default), or set `MOCK_API_TOKEN` when starting compose and use that value in the UI. The mock implements the same HTTP paths and JSON shapes as the real API; config is kept **in memory** on `PUT`.

**Live UI edits:** [docker-compose.dev.yml](../docker-compose.dev.yml) bind-mounts [web/](../web/) into the nginx container and [docker/mock-api/mock_server.py](../docker/mock-api/mock_server.py) into the mock container. Edit static files or the mock script on the host, **reload the browser** for UI changes, or run `docker compose -f docker-compose.dev.yml restart mock-api` after Python edits. Rebuild images only when [docker/Dockerfile](../docker/Dockerfile), [docker/nginx.conf](../docker/nginx.conf), or [docker/entrypoint.sh](../docker/entrypoint.sh) change. Dev nginx uses [docker/nginx.dev.conf](../docker/nginx.dev.conf) (`Cache-Control: no-store`, fixed upstream to `mock-api`).
