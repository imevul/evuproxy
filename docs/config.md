# `config.yaml` reference

EvuProxy reads a single YAML file (default **`/etc/evuproxy/config.yaml`**, overridable with `evuproxy --config`). The schema matches the `Config` struct in `internal/config/config.go`; invalid files fail validation on load and reload.

An annotated example lives at [`config/evuproxy.example.yaml`](../config/evuproxy.example.yaml).

---

## Top-level keys

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `wireguard` | object | yes | Server WireGuard interface parameters. |
| `network` | object | yes | Host networking (public-facing NIC). |
| `forwarding` | object | yes | Port forwarding from the public side into peer tunnel IPs. |
| `geo` | object | yes | Country allowlists for forwarded traffic (optional behavior via `enabled`). |
| `input_allows` | list | no | Extra `nftables` input accept rules (SSH, HTTP, etc.). |
| `peers` | list | no | WireGuard peers; entries can be `disabled: true`. |

---

## `wireguard`

| Field | Type | Description |
|-------|------|-------------|
| `interface` | string | Linux interface name (e.g. `evuproxy0`). |
| `listen_port` | int | UDP port for WireGuard (1–65535). |
| `private_key_file` | string | Path to the server’s WireGuard private key file. |
| `address` | string | Server tunnel address in CIDR form, IPv4 (e.g. `10.100.0.1/24`). |

---

## `network`

| Field | Type | Description |
|-------|------|-------------|
| `public_interface` | string | Host interface name that faces the Internet (e.g. `eth0`). Used for nftables and NAT. |
| `admin_tcp_ports` | list of int | Optional. Extra **INPUT** `accept` rules for TCP ports used by **host services** (not forwarded peer ports). Omitted or **`[]`** adds none. Typical SSH / HTTP(S) / admin UI (**9080**) rules belong in **`input_allows`** so you can edit them in one place (see the example config). |

The EvuProxy API (`evuproxy serve` on `127.0.0.1:9847`) is reached via **loopback** and does not need a rule here.

---

## `forwarding`

Forwarding is expressed as one or more **routes**. Each route publishes a set of **TCP** and/or **UDP** destination ports on the public host and DNATs matching traffic to a **peer tunnel IPv4**.

### `forwarding.routes[]`

| Field | Type | Description |
|-------|------|-------------|
| `proto` | string | `tcp`, `udp`, `both`, or several protocols separated by comma, `+`, or spaces (e.g. `tcp, udp`). `both` expands to TCP and UDP. |
| `ports` | list of strings | Port expressions passed through to nftables. Each element is a single port, range, or brace list fragment. Examples: `25565`, `80-81`, `80/tcp`-style is not used—use `proto` and plain port tokens. See **Port list syntax** below. |
| `target_ip` | string | **IPv4 host address only** (no `/mask`), e.g. `10.100.0.2`. Must match the **IPv4** of a **non-disabled** peer’s `tunnel_ip`. |

### Port list syntax

- Each entry is trimmed and joined into an nftables-style set: `{ a, b-c, … }`.
- Ranges use a hyphen (`19132-19133`).
- If you need nft brace syntax directly, include it inside a string (e.g. multiple discrete ports).

### Validation

- `forwarding.routes` may be empty until you add peers and port forwards.
- Each route must have a non-empty `proto`, at least one non-empty port string, and a valid IPv4 `target_ip`.
- `target_ip` must equal the IPv4 derived from some peer’s `tunnel_ip` (peers whose `tunnel_ip` is not valid IPv4 CIDR/host are ignored for this check).

---

## `geo`

Controls whether forwarded traffic is restricted to source IPs in downloaded country **IPDeny** zones.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | If `false`, geo sets are not required and forwarding rules accept any source (subject to normal firewalling). |
| `set_name` | string | nftables set name for IPv4 sources (default `geo_v4` when `enabled`). |
| `countries` | list of strings | Lowercase ISO country codes (e.g. `se`, `no`). Required when `enabled` is true. |
| `zone_dir` | string | Directory where per-country zone files are stored (e.g. `/etc/evuproxy/geo-zones`). Required when `enabled` is true. |

When `geo.enabled` is true, `evuproxy reload` / `update-geo` expect zone files under `zone_dir`; empty or missing zones can block traffic when geo is enabled.

---

## `input_allows`

Rules appended to the `inet evuproxy` **input** chain so the host remains reachable (SSH, HTTP, admin UI, etc.). The shipped example seeds **TCP 22**, **80/443**, and **9080** (Docker admin UI); remove **9080** here if you only reach the UI via SSH tunnel / loopback.

| Field | Type | Description |
|-------|------|-------------|
| `proto` | string | `tcp` or `udp`. |
| `dport` | string | Destination port: single port, range, or nft brace list (e.g. `"22"`, `"{ 80, 443 }"`). When `dport` contains `{` / `}`, it is emitted verbatim into nftables. |
| `note` | string | Optional; not used by the rules engine (documentation only). |

---

## `peers`

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Label (required if the peer is not `disabled`). |
| `public_key` | string | Peer’s WireGuard public key (base64). |
| `tunnel_ip` | string | Tunnel address, usually `/32` in IPv4 (e.g. `10.100.0.2/32`). May also be accepted as a bare IPv4 in validation. |
| `disabled` | bool | If `true`, the peer is skipped for validation and forwarding target checks. |

Non-disabled peers must have a non-empty `name`, `public_key`, and `tunnel_ip`.

---

## Applying changes

After editing `config.yaml`, run **`evuproxy reload --config /etc/evuproxy/config.yaml`** (or use the HTTP API) so WireGuard and nftables are regenerated. The admin UI can edit and save via **`PUT /api/v1/config`** (YAML is rewritten from the structured config; comments and unknown keys are not preserved).

---

## Related files

- **`ui-preferences.json`** next to the config file stores admin UI-only settings (not part of this schema).
- Generated artifacts (e.g. WireGuard config under `config`’s directory layout) are produced by `evuproxy reload`; do not hand-edit generated files.
