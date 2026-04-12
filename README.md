# EvuProxy

Turnkey **TCP/UDP exposure** on a Linux VPS using **WireGuard** and **nftables**, with a declarative config and optional **country allowlists** (GeoIP). The supported interface is **this repository’s YAML config + `evuproxy` CLI/API** (and optional Docker admin UI).

## Prerequisites

| Context | Requirement |
|--------|-------------|
| **VPS (install.sh)** | **Linux** host with **root** (or sudo) for install. The script installs **WireGuard**, **nftables**, **curl**, and **iproute2** via **apt**, **dnf**, or **pacman** — other distros need those packages installed manually before using `evuproxy`. |
| **Go (optional)** | **[Go 1.22+](https://go.dev/dl/)** on the **PATH** if you want `scripts/install.sh` to compile `evuproxy` from this repo. Without Go, place a prebuilt **`evuproxy`** binary at `/usr/local/bin/evuproxy` (or set `PREFIX`) after install. |
| **Build from source (dev)** | Go **1.22+** and this repository; run `go build` from the repo root (see below). |
| **Web UI** | **[Docker](https://docs.docker.com/engine/install/)** and **Docker Compose** (v2 plugin: `docker compose`) to build and run the admin UI container. |
| **Geo / IP lists** | Outbound **HTTPS** to [ipdeny.com](https://www.ipdeny.com/ipblocks/data/countries/) (or your configured source) for `update-geo` and first-time zone fetch on `reload`. |

## Quick start (VPS)

1. Clone on the server and run (as root):

   ```bash
   ./scripts/install.sh
   ```

   If **Go 1.22+** is installed, the script builds `evuproxy` into `/usr/local/bin`. Otherwise copy a prebuilt binary to that path (see **Prerequisites**).

2. Edit `/etc/evuproxy/config.yaml` (seeded from [config/evuproxy.example.yaml](config/evuproxy.example.yaml)): set `network.public_interface`, peer `public_key`, `forwarding.target_ip`, and port lists.

3. Apply:

   ```bash
   evuproxy reload --config /etc/evuproxy/config.yaml
   ```

4. On boot, `evuproxy.service` reapplies the same. Geo zones refresh via `evuproxy-geo.timer`. With **geo enabled**, the first `reload` attempts to download country zones if files are missing; ensure outbound HTTPS is allowed.

5. **WireGuard on the backend peer**: use a **narrow `AllowedIPs`** (tunnel subnet only, not `0.0.0.0/0`) so local LAN routing stays direct.

## CLI

| Command | Purpose |
|--------|---------|
| `evuproxy reload` | Regenerate `/etc/wireguard/<iface>.conf`, nftables tables `inet evuproxy` / `ip evuproxy`, load geo sets |
| `evuproxy update-geo` | Refresh IPDeny country files and reload nftables geo **in both** inet and ip tables |
| `evuproxy status` | `wg show` + `nft list table inet evuproxy` |
| `evuproxy serve` | Local HTTP API on `127.0.0.1:9847` (token in `/etc/evuproxy/api.token`) |
| `evuproxy backup --dest PATH` | Tarball of `/etc/evuproxy` |
| `evuproxy restore --archive PATH` | Extract tarball into `/etc/evuproxy`, then run `reload` |

## Local API

- Default bind: `127.0.0.1:9847` — set `EVUPROXY_API_TOKEN` or use `--token-file`.
- Endpoints: `POST /api/v1/reload`, `POST /api/v1/update-geo`, `GET /api/v1/status`, `GET /api/v1/overview`, `GET /api/v1/metrics`, `POST /api/v1/backup?path=...`, `POST /api/v1/restore?path=...`.
- Authenticate with header `X-API-Token` or `Authorization: Bearer …`.

## Web UI (Docker)

The admin UI is intended to run **in Docker only**. From the repo:

```bash
docker compose up --build
```

Browse `http://127.0.0.1:9080`. On a remote VPS, use an **SSH tunnel** instead of exposing the UI publicly. The container reaches the API via `host.docker.internal` (see [docker-compose.yml](docker-compose.yml)).

## Security notes

- Do not expose the API on `0.0.0.0` without TLS and strong auth.
- Geo data is approximate; VPN users bypass country filters.
- If geo sets are **empty** while geo is enabled, traffic may be blocked — check `journalctl` and run `evuproxy update-geo`.

## Uninstall

```bash
./scripts/uninstall.sh
# destructive config removal:
PURGE=1 ./scripts/uninstall.sh
```

## Build from source

Requires **Go 1.22 or newer** (see `go.mod`).

```bash
go build -ldflags "-X main.version=$(git describe --tags --always 2>/dev/null || echo dev)" -o evuproxy ./cmd/evuproxy
```

## License

EvuProxy is released under the [MIT License](LICENSE). Attribution is appreciated (e.g. “Uses EvuProxy” with a link to the source you received it from).

