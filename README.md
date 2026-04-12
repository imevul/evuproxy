# EvuProxy

> **Beta.** This project is under active development; behavior and APIs can change. **You use it at your own risk.** Test on non-production hosts, keep backups, and be careful when changing firewall or VPN settings—you can lock yourself out of a remote machine.

Turnkey **TCP/UDP exposure** on a Linux VPS using **WireGuard** and **nftables**, with a declarative config and optional **GeoIP** country filtering (**allow** or **block** mode in config). The supported interface is this repository’s **YAML config**, the `**evuproxy` CLI**, the **local HTTP API**, and an optional **Docker admin UI**.

## Prerequisites


| Context                     | Requirement                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VPS (`install.sh`)**      | **Linux** host with **root** (or sudo) for install. The script installs **WireGuard**, **nftables**, **curl**, and **iproute2** via **apt**, **dnf**, or **pacman**. Other distros need those packages installed manually before using `evuproxy`. |
| **Go (optional)**           | **[Go 1.22+](https://go.dev/dl/)** on your **PATH** if you want `scripts/install.sh` to compile `evuproxy` from this repo. Without Go, place a prebuilt `**evuproxy`** binary at `/usr/local/bin/evuproxy` (or set `PREFIX`) after install.        |
| **Build from source (dev)** | Go **1.22+** and this repository; run `go build` from the repo root (see [Building from source](#building-from-source)).                                                                                                                           |
| **Web UI**                  | **[Docker](https://docs.docker.com/engine/install/)** and **Docker Compose** (v2 plugin: `docker compose`) to build and run the admin UI container.                                                                                                |
| **Geo / IP lists**          | Outbound **HTTPS** to [ipdeny.com](https://www.ipdeny.com/ipblocks/data/countries/) (default zone source) for `update-geo` and first-time zone fetch on `reload`.                                                                                  |


## Quick start (VPS)

1. Clone on the server and run (as root):
  ```bash
   ./scripts/install.sh
  ```
   If **Go 1.22+** is installed, the script builds `evuproxy` into `/usr/local/bin`. Otherwise copy a prebuilt binary to that path (see **Prerequisites**).
2. Edit `/etc/evuproxy/config.yaml` (seeded from [config/evuproxy.example.yaml](config/evuproxy.example.yaml)): set `network.public_interface`, add **peers** (public keys, tunnel IPs), then `**forwarding.routes`** (each `target_ip` must match a peer’s tunnel address). Adjust `**input_allows**` if you do not want the default SSH / web / UI ports.
3. Apply:
  ```bash
   evuproxy reload --config /etc/evuproxy/config.yaml
  ```
4. On boot, `evuproxy.service` reapplies the same. Geo zones refresh via `evuproxy-geo.timer`. With **geo enabled**, the first `reload` attempts to download country zones if files are missing; ensure outbound HTTPS is allowed.
5. **WireGuard on the backend peer**: use a narrow `**AllowedIPs`** (tunnel subnet only, not `0.0.0.0/0`) so local LAN routing stays direct.
6. **Peer (client) install (Linux):** [scripts/peer-install.sh](scripts/peer-install.sh) installs `wireguard-tools`, writes `/etc/wireguard/<iface>.conf`, and enables `wg-quick`. The admin UI **Add peer** modal generates the matching one-liner (`export … && curl … | sudo -E bash`). Forks or pinned releases can set `window.EVUPROXY_PEER_INSTALL_SCRIPT_URL` before loading the UI to use another raw script URL.

## Command-line interface


| Command                           | Purpose                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `evuproxy reload`                 | Regenerate `/etc/wireguard/<iface>.conf`, nftables tables `inet evuproxy` / `ip evuproxy`, load geo sets |
| `evuproxy update-geo`             | Refresh IPDeny country files and reload nftables geo **in both** inet and ip tables                      |
| `evuproxy status`                 | `wg show` + `nft list table inet evuproxy`                                                               |
| `evuproxy serve`                  | Local HTTP API on `127.0.0.1:9847` (token in `/etc/evuproxy/api.token`)                                  |
| `evuproxy backup --dest PATH`     | Tarball of `/etc/evuproxy`                                                                               |
| `evuproxy restore --archive PATH` | Extract tarball into `/etc/evuproxy`, then run `reload`                                                  |


## Local HTTP API

### Binding, CORS, and authentication

- **Default bind:** `127.0.0.1:9847` — override with `evuproxy serve --listen`. Token: environment variable `**EVUPROXY_API_TOKEN`** or `**evuproxy serve --token-file**` (default `/etc/evuproxy/api.token`).
- **Cross-origin UI:** If the admin UI is opened from another origin (different scheme/host/port than the API), the browser needs CORS. Enable with `**evuproxy serve --cors-origins`**: a comma-separated list of exact `Origin` values (for example `https://myui.example.com,http://10.0.0.2:9080`), or `*` to allow any origin. The API remains protected by the bearer token; prefer an explicit list over `*` when the API is reachable from untrusted networks.
- **Auth:** `Authorization: Bearer …` or `X-API-Token` on `**/api/v1/*`** routes. `**GET /healthz**` is unauthenticated (for probes).

### Endpoints

All paths below are under `**/api/v1**` unless noted.


| Method        | Path                                                            | Purpose                                                                                                                                                   |
| ------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET` / `PUT` | `/config`                                                       | Read or replace full config. `**PUT**` accepts JSON, validates, writes **YAML** to disk; **does not** reload WireGuard/nftables until `**POST /reload`**. |
| `GET`         | `/pending`                                                      | Compare on-disk config to last successful apply; preview generated nftables when pending.                                                                 |
| `GET` / `PUT` | `/preferences`                                                  | UI helper fields (e.g. tunnel subnet CIDR, WireGuard endpoint for client snippets).                                                                       |
| `POST`        | `/reload`                                                       | Regenerate and apply WireGuard + nftables from config.                                                                                                    |
| `POST`        | `/update-geo`                                                   | Download zones and refresh geo sets in nftables.                                                                                                          |
| `GET`         | `/status`, `/overview`, `/metrics`, `/stats`, `/logs`, `/about` | Diagnostics, config summary, nft chain text, host stats, recent firewall-related journal lines, version info.                                             |
| `POST`        | `/backup?path=…`, `/restore?path=…`                             | Archive or restore under `/etc/evuproxy`. `**backup**` defaults `path` to `/var/backups/evuproxy-config.tgz` if omitted; `**restore**` requires `path`.   |
| `GET`         | `/healthz`                                                      | Plain `ok` (no `/api/v1` prefix, no token).                                                                                                               |


`**PUT /api/v1/config**` replaces the file with marshalled YAML from the known struct; **comments and unknown keys** in the previous file are **not** preserved.

## Web UI (Docker)

The admin UI is intended to run **in Docker only**. From the repo:

```bash
docker compose up --build
```

Browse `http://127.0.0.1:9080`. On a remote VPS, use an **SSH tunnel** instead of exposing the UI publicly. The UI container uses **host networking** so nginx can proxy `/api` to `**127.0.0.1:9847`** without binding the API on `0.0.0.0`. Override `**EVUPROXY_UI_LISTEN**` (e.g. `0.0.0.0:9080`) only for temporary LAN tests. **Host network is Linux-oriented**; use the dev mock stack on other setups if needed.

### Local UI with mock API

To try the admin UI **without** `evuproxy serve` on the host (no WireGuard or nftables changes), use the dev stack: a stub API in Docker plus the same UI image, wired on the compose network.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://127.0.0.1:9080` and enter API token `**dev**` (default), or set `MOCK_API_TOKEN` when starting compose and use that value in the UI. The mock implements the same HTTP paths and JSON shapes as the real API; config is kept **in memory** on `PUT`.

**Live UI edits:** [docker-compose.dev.yml](docker-compose.dev.yml) bind-mounts [web/](web/) into the nginx container and [docker/mock-api/mock_server.py](docker/mock-api/mock_server.py) into the mock container. Edit static files or the mock script on the host, **reload the browser** for UI changes, or run `docker compose -f docker-compose.dev.yml restart mock-api` after Python edits. Rebuild images only when [docker/Dockerfile](docker/Dockerfile), [docker/nginx.conf](docker/nginx.conf), or [docker/entrypoint.sh](docker/entrypoint.sh) change. Dev nginx uses [docker/nginx.dev.conf](docker/nginx.dev.conf) (`Cache-Control: no-store`, fixed upstream to `mock-api`).

## Security notes

- After `reload`, nftables **INPUT** is restrictive; the example seed allows **TCP 22**, **80/443**, and **9080** (Docker UI) via `**input_allows`**. Remove **9080** there if you only use SSH tunnels to the UI.
- Do not expose the API on `0.0.0.0` without TLS and strong auth.
- Geo data is approximate; VPN users bypass country filters.
- If geo sets are **empty** while geo is enabled, traffic may be blocked — check `journalctl` and run `evuproxy update-geo`.

## Uninstall

```bash
./scripts/uninstall.sh
# destructive config removal:
PURGE=1 ./scripts/uninstall.sh
```

## Building from source

Requires **Go 1.22 or newer** (see `go.mod`).

```bash
go build -ldflags "-X main.version=$(git describe --tags --always 2>/dev/null || echo dev)" -o evuproxy ./cmd/evuproxy
```

## Releases and versioning

EvuProxy uses **SemVer** `**0.MINOR.PATCH`** while in beta (`0.x`). **Patch** releases cover fixes and small tweaks; **minor** releases cover new features or larger behavior changes. Breaking changes on the `0.x` line are shipped as a **minor** bump (common practice for unstable `0.x` series).

[Release Please](https://github.com/googleapis/release-please) drives releases from [Conventional Commits](https://www.conventionalcommits.org/) on `main` (for example `feat:` for features, `fix:` for fixes, and `feat!:` or a `BREAKING CHANGE:` footer for breaking changes). It opens a **release pull request** that bumps the version in [.release-please-manifest.json](.release-please-manifest.json), updates [CHANGELOG.md](CHANGELOG.md), and updates the embedded version in [cmd/evuproxy/main.go](cmd/evuproxy/main.go). Merging that PR creates the Git tag and **GitHub Release**. Another workflow then builds **Linux** binaries (`amd64`, `arm64`), a `**git archive`** source ZIP, and **SHA256SUMS**, and uploads them to the release.

The running binary exposes its version via `evuproxy version`, `GET /api/v1/about`, and the admin UI sidebar.

## Third-party data and attribution

The default GeoIP country zone files are fetched from IPDeny’s public dataset at `https://www.ipdeny.com/ipblocks/data/countries/<cc>.zone` (see `[internal/gen/geo.go](internal/gen/geo.go)`).

**Powered by [IPDENY.COM](https://www.ipdeny.com) IP database in the default configuration.**

Further reading from IPDeny:

- [Copyright notice](https://www.ipdeny.com/copyright.php)
- [Link back / examples](https://www.ipdeny.com/linkback.php)
- [Usage limits](https://www.ipdeny.com/usagelimits.php)

`evuproxy` downloads zones **one at a time** (no parallel connections) and pauses **750ms** between successive requests to follow IPDeny’s suggested spacing. Together with the default `**evuproxy-geo.timer`** (about once per 24h) and typical `geo.countries` lists, usage stays well under their **5000 zone downloads per day per IP** guideline; see [usage limits](https://www.ipdeny.com/usagelimits.php) for the full policy.

If you **copy or redistribute** downloaded `.zone` files, keep IPDeny’s `**Copyrights.txt`** with them as described in their [copyright notice](https://www.ipdeny.com/copyright.php).

## License

EvuProxy is released under the [MIT License](LICENSE). Attribution is appreciated (e.g. “Uses EvuProxy” with a link to the source you received it from).