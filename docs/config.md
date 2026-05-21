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
| `forward_allow_docker_bridges` | bool | Optional, default `false`. If `true`, adds **FORWARD** `accept` rules for typical **Docker IPv4** ranges (**`172.16.0.0/12`**, **`192.168.0.0/16`**): **egress** (container → internet via `public_interface`) and **ingress** (WAN → published container ports after DNAT; `oifname` is not the WireGuard interface). Without these, EvuProxy’s default **forward** policy (`drop`) blocks both **container egress** and **inbound** traffic to Docker. WireGuard peer tunnel IPs are usually **`10.x`** and are not covered by those ranges. |
| `forward_extra_local_cidrs` | list of strings | Optional IPv4 CIDRs (e.g. **`10.89.0.0/24`**) for extra **FORWARD** ingress/egress (same semantics as above), e.g. when Docker uses a **`10.x`** network. Validated on load. |

The EvuProxy API (`evuproxy serve` on `127.0.0.1:9847`) is reached via **loopback** and does not need a rule here.

---

## `forwarding`

Forwarding is expressed as one or more **routes**. Each route publishes a set of **TCP** and/or **UDP** destination ports on the public host and DNATs matching traffic to a **peer tunnel IPv4**.

| Field | Type | Description |
|-------|------|-------------|
| `maintenance_mode` | bool (optional) | If `true`, **no** forward DNAT or forward-accept rules are generated (WireGuard and `input_allows` stay as configured). Use for maintenance windows. |
| `source_deny_cidrs` | list of strings (optional) | Global IPv4/CIDR **denylist** for forwarded traffic (WAN sources). Evaluated before per-route rules. |
| `rate_limit` | object (optional) | Global defaults for rate limits on published forward ports (off when all fields zero). Per-route `rate_limit` overrides non-zero fields. |

### `forwarding.routes[]`

| Field | Type | Description |
|-------|------|-------------|
| `proto` | string | `tcp`, `udp`, `both`, or several protocols separated by comma, `+`, or spaces (e.g. `tcp, udp`). `both` expands to TCP and UDP. |
| `ports` | list of strings | Port expressions passed through to nftables. Each element is a single port, range, or brace list fragment. Examples: `25565`, `80-81`, `80/tcp`-style is not used—use `proto` and plain port tokens. See **Port list syntax** below. |
| `target_ip` | string | **IPv4 host address only** (no `/mask`), e.g. `10.100.0.2`. Must match the **IPv4** of a **non-disabled** peer’s `tunnel_ip`. |
| `disabled` | bool (optional) | If `true`, the route is kept in config but **omitted** from generated nftables (no DNAT/forward rules until re-enabled). Other fields are not validated while disabled. |
| `source_allow_cidrs` | list of strings (optional) | If non-empty, only these WAN IPv4 sources may use this route (allowlist). |
| `source_deny_cidrs` | list of strings (optional) | Per-route WAN IPv4/CIDR denylist (after allowlist / geo). |
| `port_maps` | list of objects (optional) | Maps **public** port expressions (must match a `ports[]` entry) to **internal** DNAT ports on `target_ip`. Omitted = 1:1 (public port equals internal). Each object: `public`, `internal` (same syntax as `ports[]`; ranges must have equal width). |
| `geo_mode` | string (optional) | `inherit` (default), `off` (skip global geo for this route), or `custom` (use `geo_countries`). |
| `geo_countries` | list of strings | Required when `geo_mode` is `custom` (same country codes as global `geo.countries`). |
| `rate_limit` | object (optional) | Per-route overrides; merges with `forwarding.rate_limit`. |

### `rate_limit` (global or per-route)

| Field | Type | Description |
|-------|------|-------------|
| `tcp_syn_per_second` | int (optional) | Drop excess **new** TCP SYNs per **source IP** to published ports (1–10000). |
| `max_conn_per_ip` | int (optional) | Drop when a **source IP** exceeds concurrent connection count to the port (dynamic nft set + `ct count over N`, 1–65535). |
| `udp_per_second` | int (optional) | Drop excess **new** UDP packets per **source IP** (1–100000); can affect bursty game traffic. |

Drops are logged with prefix `evuproxy-ratelimit` and appear in **Logs** when enabled.

Limits apply on **INPUT** (host-destined) and **forward** (WAN→tunnel path), not in nat prerouting. **`geo.break_glass_cidrs` exempts rate limits** (same as CrowdSec/geo bypass).

**Global vs per-route sets:** Fields set under **`forwarding.rate_limit`** use shared nft sets (`ratelimit_*_v4`) on every route that does not override that field. A per-route **`rate_limit`** override uses route-scoped sets (`ratelimit_*_rN`) so limits apply only to that route’s published ports. Example: global `tcp_syn_per_second: 10` on all routes, but route 0 overrides to `100` — route 0 uses its own meter; other routes share the global 10/s cap per source IP.

### `crowdsec` (optional)

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool (optional) | Default `false`. When `true`, generated rules drop sources in nft set **`crowdsec_block_v4`** on published ports (after break-glass). Requires the [CrowdSec nftables bouncer](../contrib/crowdsec/README.md) on the same host. |

**nftables evaluation order (forward path):** global deny → per-route deny → CrowdSec block on **inet** forward (if enabled; break-glass exempt) → per-source rate limits → geo on INPUT/prerouting (break-glass skips geo) → per-route allow → DNAT.

CrowdSec drops apply on **inet** INPUT/forward only (not **`ip` prerouting** before DNAT). Banned sources are still DNAT’d, then dropped in forward — functionally blocked. Early drop in prerouting is deferred (v2) if needed.

### Port list syntax

- Each entry is trimmed and joined into an nftables-style set: `{ a, b-c, … }`.
- Ranges use a hyphen (`19132-19133`).
- If you need nft brace syntax directly, include it inside a string (e.g. multiple discrete ports).

### Validation

- `forwarding.routes` may be empty until you add peers and port forwards.
- Each **enabled** route must have a non-empty `proto`, at least one non-empty port string, and a valid IPv4 `target_ip`.
- `target_ip` must equal the IPv4 derived from some peer’s `tunnel_ip` (peers whose `tunnel_ip` is not valid IPv4 CIDR/host are ignored for this check). **Disabled** routes skip these checks.

---

## `geo`

Controls whether forwarded traffic is restricted to source IPs in downloaded country **IPDeny** zones.

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | If `false`, geo sets are not required and forwarding rules accept any source (subject to normal firewalling). |
| `set_name` | string | nftables set name for IPv4 sources (default `geo_v4` when `enabled`). |
| `countries` | list of strings | Lowercase ISO country codes (e.g. `se`, `no`). Required when `enabled` is true. |
| `zone_dir` | string | Directory where per-country zone files are stored (e.g. `/etc/evuproxy/geo-zones`). Required when `enabled` is true. |
| `apply_to_input_allows` | bool | If `true` and `enabled` is true, **`input_allows`** use the same geo allow/block logic as forwarded ports. Default **`false`**: **`input_allows`** stay plain INPUT accepts (SSH, HTTP, etc. remain reachable from any IPv4 source regardless of country lists). In the admin UI this appears on the **Geoblocking** page under advanced fields (enable **Advanced mode** in **Settings**). Geo rules use **`ip saddr`** (IPv4 only); IPv6 to the same TCP/UDP ports is not matched by those lines and may hit the chain **policy** (often **drop**)—plan separate rules if you need IPv6 admin access. **`network.admin_tcp_ports`** are still emitted as unconditional TCP accepts after **`input_allows`**; they are **not** wrapped by this option—avoid duplicating sensitive ports there if you expect geo to cover them. |
| `break_glass_cidrs` | list of strings (optional) | IPv4/CIDR sources that **always pass** geo filtering on INPUT and forward paths. Use sparingly for operator escape hatches. |

When `geo.enabled` is true, `evuproxy reload` / `update-geo` expect zone files under `zone_dir`; empty or missing zones can block traffic when geo is enabled.

---

## `input_allows`

Rules appended to the `inet evuproxy` **input** chain so the host remains reachable (SSH, HTTP, admin UI, etc.). The shipped example seeds **TCP 22**, **80/443**, and **9080** (Docker admin UI); remove **9080** here if you only reach the UI via SSH tunnel / loopback.

| Field | Type | Description |
|-------|------|-------------|
| `proto` | string | `tcp` or `udp`. |
| `dport` | string | Destination port: single port, range, or nft brace list (e.g. `"22"`, `"{ 80, 443 }"`). When `dport` contains `{` / `}`, it is emitted verbatim into nftables. **Disabled** entries skip validation of `dport`. |
| `note` | string | Optional; not used by the rules engine (documentation only). |
| `disabled` | bool | If `true`, the rule is kept in config but omitted from generated nftables (no INPUT accept line) until enabled. |

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

### Applied snapshots (`config.yaml.bak` and `config.yaml.bak.1` … `.bak.5`)

After each **successful** **`evuproxy reload`** (or **`POST /api/v1/reload`**), EvuProxy updates history from the current **`config.yaml`**:

- If **`config.yaml.bak`** is missing, it is created with the current file bytes (first successful apply).
- If the current **`config.yaml`** bytes **equal** **`config.yaml.bak`**, nothing else changes (avoids history noise on identical re-applies).
- If they **differ**, the chain rotates: **`config.yaml.bak`** → **`config.yaml.bak.1`** → … → **`config.yaml.bak.5`** (oldest dropped), then **`config.yaml.bak`** is replaced with the config that was just applied.

**`PUT /api/v1/config`** (and the admin UI) only change **`config.yaml`**; they do **not** update **`.bak*`** files. Saved edits can **drift** from **`.bak`** until you apply.

- **`evuproxy discard-pending --config …`**: replace **`config.yaml`** with **`config.yaml.bak`** when they differ (revert saved YAML to the last distinct applied snapshot). **`POST /api/v1/config/discard`** does the same.
- **`evuproxy restore-previous-applied --config …`**: replace **`config.yaml`** with the first **`config.yaml.bak.N`** (`N` = 1…5) whose contents **differ** from **`config.yaml.bak`**. Current **`config.yaml`** content is overwritten (including edits not yet reflected in **`.bak`**). No **`.bak*`** files are modified. **`POST /api/v1/config/restore-previous-applied`** does the same.

The host still runs the last applied rules until you reload again, use **Pending changes → Apply**, or **`POST /api/v1/reload`**.

---

## Related files

- **`ui-preferences.json`** next to the config file stores admin UI-only settings (not part of this schema), including **`metrics_collection_enabled`** for the **`evuproxy metrics`** collector.
- **`metrics.sqlite`** (default beside **`config.yaml`**) stores peer ICMP samples for **`GET /api/v1/metrics/peers`**. **`evuproxy metrics`** opens it read-write (WAL creates **`-wal`** / **`-shm`** siblings alongside the file). **`evuproxy serve`** needs read-only access for the same path; override the API’s file with **`evuproxy serve --metrics-db`**. If the collector and API run as different users, use a shared group or ACLs so both can access the DB files. See **`templates/evuproxy-metrics.service`** (optional **`User=`** / **`Group=`** when not running as root).
- **`config.yaml.bak`** and **`config.yaml.bak.1`** … **`.bak.5`**: last applied snapshot and rotated history (maintained on successful reload only).
- Generated artifacts (e.g. WireGuard config under `config`’s directory layout) are produced by `evuproxy reload`; do not hand-edit generated files.
