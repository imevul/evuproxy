# EvuProxy

> **Beta.** This project is under active development; behavior and APIs can change. **You use it at your own risk.** Test on non-production hosts, keep backups, and be careful when changing firewall or VPN settings—you can lock yourself out of a remote machine.

Turnkey **TCP/UDP exposure** on a Linux VPS using **WireGuard** and **nftables**, with a declarative config and optional **GeoIP** country filtering (**allow** or **block** mode in config). The supported interface is this repository’s **YAML config**, the **`evuproxy` CLI**, the **local HTTP API**, and an optional **Docker admin UI**.

**More documentation:** [docs/README.md](docs/README.md) (HTTP API, web UI, security, third-party data).

## Prerequisites


| Context                     | Requirement                                                                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **VPS (`install.sh`)**      | **Linux** host with **root** (or sudo) for install. The script installs **WireGuard**, **nftables**, **curl**, and **iproute2** via **apt**, **dnf**, or **pacman**. Other distros need those packages installed manually before using `evuproxy`. |
| **Go (optional)**           | **[Go 1.22+](https://go.dev/dl/)** on your **PATH** if you want `scripts/install.sh` to compile `evuproxy` from this repo. Without Go, place a prebuilt **`evuproxy`** binary at `/usr/local/bin/evuproxy` (or set `PREFIX`) after install.        |
| **Build from source (dev)** | Go **1.22+** and this repository; run `go build` from the repo root (see [Building from source](#building-from-source)).                                                                                                                           |
| **Web UI**                  | **[Docker](https://docs.docker.com/engine/install/)** and **Docker Compose** (v2 plugin: `docker compose`) to build and run the admin UI container.                                                                                                |
| **Geo / IP lists**          | Outbound **HTTPS** to [ipdeny.com](https://www.ipdeny.com/ipblocks/data/countries/) (default zone source) for `update-geo` and first-time zone fetch on `reload`. See [docs/third-party-data.md](docs/third-party-data.md) for attribution and limits.                                                                                  |


## Quick start (VPS)

1. Clone on the server and run (as root):
  ```bash
   ./scripts/install.sh
  ```
   If **Go 1.22+** is installed, the script builds `evuproxy` into `/usr/local/bin`. Otherwise copy a prebuilt binary to that path (see **Prerequisites**). The **HTTP API** (`evuproxy-api.service`) is optional at install time (interactive prompt, or set **`EVUPROXY_INSTALL_API`** to override); see [docs/http-api.md](docs/http-api.md#install-script-and-optional-api-enable).
2. Edit `/etc/evuproxy/config.yaml` (seeded from [config/evuproxy.example.yaml](config/evuproxy.example.yaml)): set `network.public_interface`, add **peers** (public keys, tunnel IPs), then **`forwarding.routes`** (each `target_ip` must match a peer’s tunnel address). Adjust **`input_allows`** if you do not want the default SSH / web / UI ports.
3. Apply:
  ```bash
   evuproxy reload --config /etc/evuproxy/config.yaml
  ```
4. On boot, `evuproxy.service` reapplies the same. Geo zones refresh via `evuproxy-geo.timer`. With **geo enabled**, the first `reload` attempts to download country zones if files are missing; ensure outbound HTTPS is allowed.
5. **WireGuard on the backend peer**: use a narrow **`AllowedIPs`** (tunnel subnet only, not `0.0.0.0/0`) so local LAN routing stays direct.
6. **Peer (client) install (Linux):** [scripts/peer-install.sh](scripts/peer-install.sh) installs `wireguard-tools`, writes `/etc/wireguard/<iface>.conf`, and enables `wg-quick`. The admin UI **Add peer** modal generates a short shell script: download the install script to a temp file, print `sha256sum`, then run with `sudo` after you compare the hash to **`scripts/peer-install.sh`** in **SHA256SUMS** on the matching [GitHub Release](https://github.com/imevul/evuproxy/releases) (same tag or commit as the raw URL). For production peers, set `window.EVUPROXY_PEER_INSTALL_SCRIPT_URL` to a **tag-pinned** raw URL (not floating `main`) so the checksum in a fixed release applies.

## Command-line interface


| Command                           | Purpose                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `evuproxy reload`                 | Regenerate `/etc/wireguard/<iface>.conf`, nftables tables `inet evuproxy` / `ip evuproxy`, load geo sets |
| `evuproxy update-geo`             | Refresh IPDeny country files and reload nftables geo **in both** inet and ip tables                      |
| `evuproxy status`                 | `wg show` + `nft list table inet evuproxy`                                                               |
| `evuproxy serve`                  | Local HTTP API on `127.0.0.1:9847` (token in `/etc/evuproxy/api.token`)                                  |
| `evuproxy backup --dest PATH`     | Tarball of `/etc/evuproxy`                                                                               |
| `evuproxy restore --archive PATH` | Extract tarball into `/etc/evuproxy`, then run `reload`                                                  |
| `evuproxy discard-pending`        | Replace `config.yaml` with `config.yaml.bak` when they differ; run `reload` to apply to the host         |
| `evuproxy restore-previous-applied` | Replace `config.yaml` from `config.yaml.bak.N` history (see docs); run `reload` to apply              |
| `evuproxy peer-add`                 | Append a WireGuard peer to `config.yaml` (optional key generation, auto tunnel IP); if you omit **`--public-key`**, set **`--private-key-out`** (0600 file) and/or **`--print-generated-key`** (stderr); **`--apply`** runs `reload` |

**Environment (API):** **`EVUPROXY_LOG_DIR`** — if set (e.g. `/var/log/evuproxy`), `evuproxy serve` appends JSON logs to **`evuproxy.jsonl`** under that directory as well as stderr. **`EVUPROXY_EVENTS_MAX_BYTES`** — optional cap for **`state/events.jsonl`** (clamped; see [docs/http-api.md](docs/http-api.md)).


## Local HTTP API and web UI

- **HTTP API** (bind address, auth, CORS, endpoints, backup paths): [docs/http-api.md](docs/http-api.md)
- **Web UI** (Docker compose, mock dev stack): [docs/web-ui.md](docs/web-ui.md)
- **Security and privacy** (telemetry, token storage, operational notes): [docs/security-and-privacy.md](docs/security-and-privacy.md)
- **Third-party / IPDeny** (attribution, usage): [docs/third-party-data.md](docs/third-party-data.md)

## Updating

For installs that used **git clone** on the server and build from this repo, [scripts/update.sh](scripts/update.sh) refreshes the tree and binary:

```bash
cd /path/to/evuproxy   # repository root
./scripts/update.sh
```

The script runs **`git pull`**, builds with [scripts/rebuild.sh](scripts/rebuild.sh) (needs **Go 1.22+** on `PATH`), installs to **`PREFIX`** (default `/usr/local`) when EvuProxy **systemd units** exist under `/etc/systemd/system/`, restarts **active** `evuproxy.service` / `evuproxy-api.service`, and if the repo’s **Docker Compose** UI stack is already running it runs **`docker compose up --build -d`** for that file.

**Limitations**

- **`config.yaml` is yours:** the updater does not migrate, merge, or validate configuration. New releases may require new fields, renames, or stricter validation—read [CHANGELOG.md](CHANGELOG.md) and compare with [config/evuproxy.example.yaml](config/evuproxy.example.yaml), then run **`evuproxy reload`** (or fix issues before reloading) so you are not locked out.
- **Local git changes:** `git pull` fails if you have uncommitted edits in the clone; commit, stash, or discard them first.
- **Binary-only installs** (prebuilt `evuproxy` copied to `/usr/local/bin` without this repo) are not updated by this script—replace the binary from a [release](https://github.com/imevul/evuproxy/releases) and restart services manually.
- **Peers and other hosts** are unchanged; client WireGuard configs are not updated by `update.sh`.

**Backup and rollback**

- Before updating, take a **config backup**: `evuproxy backup --dest /var/backups/evuproxy-pre-update.tgz` (or use the HTTP API—see [docs/http-api.md](docs/http-api.md) for path allowlisting), and/or copy `/etc/evuproxy/config.yaml` somewhere safe.
- If something goes wrong after upgrade, **stop** the services, **restore** the archive with `evuproxy restore --archive …` (then `reload`), or put back the saved `config.yaml` and reinstall the **previous** binary (e.g. from an older GitHub release or `git checkout <tag>` + `sudo ./scripts/rebuild.sh --install`).
- Keeping a copy of the old **`evuproxy` binary** under another name makes rollback faster than rebuilding from git history.

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

EvuProxy uses **SemVer** **`0.MINOR.PATCH`** while in beta (`0.x`). **Patch** releases cover fixes and small tweaks; **minor** releases cover new features or larger behavior changes. Breaking changes on the `0.x` line are shipped as a **minor** bump (common practice for unstable `0.x` series).

[Release Please](https://github.com/googleapis/release-please) drives releases from [Conventional Commits](https://www.conventionalcommits.org/) on `main` (for example `feat:` for features, `fix:` for fixes, and `feat!:` or a `BREAKING CHANGE:` footer for breaking changes). It opens a **release pull request** that bumps the version in [.release-please-manifest.json](.release-please-manifest.json), updates [CHANGELOG.md](CHANGELOG.md), and updates the embedded version in [cmd/evuproxy/main.go](cmd/evuproxy/main.go). Merging that PR creates the Git tag and **GitHub Release**. Another workflow then builds **Linux** binaries (`amd64`, `arm64`), a **`git archive`** source ZIP, and **SHA256SUMS**, and uploads them to the release.

The running binary exposes its version via `evuproxy version`, `GET /api/v1/about`, and the admin UI sidebar.

## License

EvuProxy is released under the [MIT License](LICENSE). Attribution is appreciated (e.g. “Uses EvuProxy” with a link to the source you received it from).
