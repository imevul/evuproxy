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
| `auto_pause` | object | no | Global settings for routes with `pause_when_peer_offline`. |
| `geo` | object | yes | Country allow/block lists for forwarded traffic (optional behavior via `enabled`; see `mode`). |
| `crowdsec` | object | no | CrowdSec nftables-bouncer integration (drop banned sources). |
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

### WireGuard and systemd-networkd / netplan

The default interface name **`evuproxy0`** starts with **`e`**. A common netplan snippet matches **all** such names:

```yaml
network:
  ethernets:
    nic:
      match:
        name: "e*"   # matches eth0 AND evuproxy0
      dhcp4: true
```

When **systemd-networkd** reloads (for example during `apt-daily-upgrade`), it can reconfigure `evuproxy0` under that match and **wipe** `wireguard.address`. DNATed forwards then leave via the default route (`OUT=eth0` instead of `OUT=evuproxy0`) and hit **`evuproxy-forward-drop`**, while peers may still show a recent WireGuard handshake.

**Prevention (install/update/reload):** when netplan or systemd-networkd appears in use, EvuProxy installs:

`/etc/systemd/network/00-<interface>.network`

```ini
[Match]
Name=evuproxy0

[Link]
Unmanaged=yes
```

The **`00-`** prefix sorts before netplan’s typical **`10-netplan-*.network`** so `Unmanaged=yes` wins (networkd applies the first matching `.network` file). Install and `scripts/update.sh` run `evuproxy ensure-wg-networkd` and print the path. `evuproxy reload` refreshes the same file quietly. Uninstall removes it (and any legacy `80-` drop-in).

**Also fix netplan** so it matches only the real NIC (e.g. `name: "eth0"`), not `e*`.

**Recovery** if the address is already gone:

```bash
sudo ip -4 addr replace 10.100.0.1/24 dev evuproxy0   # use your wireguard.address / interface
# or
sudo evuproxy reload
```

`evuproxy status` and the Overview “Needs attention” list warn when the tunnel address is missing on a live iface.

### WireGuard server endpoint (UI preferences)

Peer install snippets use **Settings → WireGuard server endpoint** (`ui-preferences.json`, not this YAML). That value must be a **UDP-reachable** `host:port` for this VPS.

Do **not** use a Cloudflare **orange-cloud** (proxied) hostname: DNS can return Cloudflare anycast (often IPv6 `2606:4700:…`) instead of the server, so clients show `0 B received` while the host looks healthy. Prefer the VPS public IP, or a **grey-cloud / DNS-only** name whose A/AAAA records match this host.

Overview / Settings warn (`wg_endpoint_host_mismatch`) when the endpoint looks proxied (e.g. Cloudflare anycast) or, on hosts with a public address on the NIC, when DNS/IP does not match those addresses. DNS failures may surface as `wg_endpoint_dns_lookup_failed`. On NAT/EIP hosts (only private addresses on the NIC), non-Cloudflare mismatches are skipped to avoid false positives.

---

## `network`

| Field | Type | Description |
|-------|------|-------------|
| `public_interface` | string | Host interface name that faces the Internet (e.g. `eth0`). Used for nftables and NAT. |
| `admin_tcp_ports` | list of int | Optional. Extra **INPUT** `accept` rules for TCP ports used by **host services** (not forwarded peer ports). Omitted or **`[]`** adds none. Typical SSH / HTTP(S) / admin UI (**9080**) rules belong in **`input_allows`** so you can edit them in one place (see the example config). |
| `forward_allow_docker_bridges` | bool | Optional, default `false`. If `true`, adds **FORWARD** `accept` rules for typical **Docker IPv4** ranges (**`172.16.0.0/12`**, **`192.168.0.0/16`**): **egress** (container → internet via `public_interface`) and **ingress** (WAN → published container ports after DNAT; `oifname` is not the WireGuard interface). Without these, EvuProxy’s default **forward** policy (`drop`) blocks both **container egress** and **inbound** traffic to Docker. WireGuard peer tunnel IPs are usually **`10.x`** and are not covered by those ranges. |
| `forward_extra_local_cidrs` | list of strings | Optional IPv4 CIDRs (e.g. **`10.89.0.0/24`**) for extra **FORWARD** ingress/egress (same semantics as above), e.g. when Docker uses a **`10.x`** network. Validated on load. |

### Docker on the same host

EvuProxy and the **Docker engine** both filter **FORWARD** traffic. They operate at **different layers** and solve **different** problems. Enabling one does not replace the other.

| Layer | What it controls |
|-------|------------------|
| **EvuProxy** (`table inet evuproxy`, chain `forward`, policy **drop**) | Published **WAN → WireGuard peer** ports (DNAT, CrowdSec, rate limits, geo), plus optional allows for **Docker bridge CIDRs** when `forward_allow_docker_bridges` is set. |
| **Docker** (`iptables` chain **`DOCKER-USER`**, before `DOCKER-FORWARD`) | By default, only Docker-related forwards; **other** forwarded flows (including EvuProxy’s WAN → WireGuard path) must be **explicitly allowed** in `DOCKER-USER` or Docker drops them **before** EvuProxy’s nft rules run. |

**`forward_allow_docker_bridges`** adds EvuProxy **accept** rules for traffic between `public_interface` and typical **Docker bridge** ranges (`172.16.0.0/12`, `192.168.0.0/16`): container egress and WAN → container ingress. Those rules require **`oifname !=` WireGuard** — they do **not** cover **`public_interface` → WireGuard** (peer tunnel IPs are usually **`10.x`**). WireGuard forwards are handled by separate per-route accept rules in EvuProxy, but only if the packet reaches that chain.

**When Docker is installed** (e.g. optional CrowdSec compose, admin UI, other containers), add **`DOCKER-USER`** allows for EvuProxy’s forward path (replace interface names with your `public_interface` and `wireguard.interface`):

```bash
# Replace eth0 / evuproxy0 with values from config.yaml
sudo iptables -I DOCKER-USER 1 -i eth0 -o evuproxy0 -j ACCEPT
sudo iptables -I DOCKER-USER 2 -i evuproxy0 -o eth0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT
```

Persist these outside EvuProxy reload (e.g. boot script or firewall unit); `evuproxy reload` does not manage `DOCKER-USER`.

**Symptoms** when `DOCKER-USER` is missing: clients **timeout** on published forward ports; **`evuproxy-forward-drop`** does not appear in the kernel log (Docker dropped the packet earlier); a direct connection from the host to a **peer tunnel IP:port** may still work (that uses **OUTPUT**, not **FORWARD**). **`forward_allow_docker_bridges: true`** alone does not fix this.

Hosts **without** the Docker engine, or without forwarded traffic while Docker is running, may never hit this issue.

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
| `name` | string (optional) | Label for operators, shown first in the web UI. Up to 64 characters, no newlines or control characters. Not used by the rules engine, and need not be unique. Checked even when the route is disabled. |
| `proto` | string | `tcp`, `udp`, `both`, or several protocols separated by comma, `+`, or spaces (e.g. `tcp, udp`). `both` expands to TCP and UDP. |
| `ports` | list of strings | Port expressions passed through to nftables. Each element is a single port, range, or brace list fragment. Examples: `25565`, `80-81`, `80/tcp`-style is not used—use `proto` and plain port tokens. See **Port list syntax** below. |
| `target_ip` | string | **IPv4 host address only** (no `/mask`), e.g. `10.100.0.2`. Must match the **IPv4** of a **non-disabled** peer’s `tunnel_ip`. |
| `disabled` | bool (optional) | If `true`, the route is kept in config but **omitted** from generated nftables (no DNAT/forward rules until re-enabled). Other fields are not validated while disabled. |
| `source_allow_cidrs` | list of strings (optional) | If non-empty, only these WAN IPv4 sources may use this route (allowlist). |
| `source_deny_cidrs` | list of strings (optional) | Per-route WAN IPv4/CIDR denylist. Checked before the allowlist and geo, so a source on both lists is refused. |
| `port_maps` | list of objects (optional) | Maps **public** port expressions (must match a `ports[]` entry) to **internal** DNAT ports on `target_ip`. Omitted = 1:1 (public port equals internal). Each object: `public`, `internal` (same syntax as `ports[]`; ranges must have equal width, and each public port maps to the port at the same offset, one DNAT rule per port). The internal port is only open to traffic that came in on its public port. |
| `geo_mode` | string (optional) | `inherit` (default), `off` (skip global geo for this route), or `custom` (use `geo_countries`). |
| `geo_countries` | list of strings | Required when `geo_mode` is `custom` (same country codes as global `geo.countries`). |
| `rate_limit` | object (optional) | Per-route overrides; merges with `forwarding.rate_limit`. |
| `pause_when_peer_offline` | bool (optional) | Default `false`. If `true`, the route is auto-paused while its target peer is offline. See [`auto_pause`](#auto_pause). |

### `rate_limit` (global or per-route)

| Field | Type | Description |
|-------|------|-------------|
| `tcp_syn_per_second` | int (optional) | Drop excess **new** TCP SYNs per **source IP** to published ports (1–10000). |
| `max_conn_per_ip` | int (optional) | Drop when a **source IP** exceeds **N** concurrent flows to the route, counted separately for TCP and UDP (`ct count over N` in a per-source set; 1–65535). Not a sticky ban — when connections close, new ones are allowed again. |
| `udp_per_second` | int (optional) | Drop excess UDP packets per **source IP** (1–100000); meters **every datagram**, not only the first packet of a flow; can affect bursty game traffic. |

Drops are logged with prefix `evuproxy-ratelimit` and appear in **Logs** when enabled, and in **Stats** nftables counters when [`stats.drop_counters`](#stats) is on.

Limits apply on **INPUT** (host-destined) and **forward** (WAN→tunnel path), not in nat prerouting. **`geo.break_glass_cidrs` exempts rate limits** (same as CrowdSec/geo bypass).

**Forward path (primary enforcement):** on **inet forward**, per-source rate limits are evaluated **before** the blanket `ct state established,related accept`, so max-conn and UDP pps limits apply to forwarded game/service traffic. **INPUT** still has an early established accept at the top of the chain, so those same rules on INPUT are best treated as defense-in-depth.

**Sets:** all three limits use dynamic nft sets keyed by source IP. **`tcp_syn_per_second`** and **`udp_per_second`** use `ratelimit_syn_*` and `ratelimit_udp_*`, and allow at most rate × time + burst (burst is twice the rate, or the rate itself above 50/s). **`max_conn_per_ip`** always uses one set per route and protocol, `ratelimit_conn_rN_tcp` and `ratelimit_conn_rN_udp`, even when the limit is global. A reload starts the rate meters and connection counts again from zero.

**Global vs per-route sets:** Fields set under **`forwarding.rate_limit`** use shared nft sets (`ratelimit_syn_v4`, `ratelimit_udp_v4`) on every route that does not override that field. A per-route **`rate_limit`** override uses route-scoped sets (`ratelimit_syn_rN`, `ratelimit_udp_rN`) so limits apply only to that route’s published ports. Example: global `tcp_syn_per_second: 10` on all routes, but route 0 overrides to `100` — route 0 uses its own meter; other routes share the global 10/s cap per source IP.

**nftables evaluation order (forward path):** global deny → per-route deny → CrowdSec block on **inet** forward (if enabled; break-glass exempt) → per-source rate limits (before blanket `established,related accept`) → geo on INPUT/prerouting (break-glass skips geo) → per-route allow → DNAT.

### Port list syntax

- Each entry is trimmed and joined into an nftables-style set: `{ a, b-c, … }`.
- Ranges use a hyphen (`19132-19133`).
- If you need nft brace syntax directly, include it inside a string (e.g. multiple discrete ports).

### Validation

- `forwarding.routes` may be empty until you add peers and port forwards.
- Each **enabled** route must have a non-empty `proto`, at least one non-empty port string, and a valid IPv4 `target_ip`.
- `target_ip` must equal the IPv4 derived from some peer’s `tunnel_ip` (peers whose `tunnel_ip` is not valid IPv4 CIDR/host are ignored for this check). **Disabled** routes skip these checks.

---

## `auto_pause`

Auto-pause is optional and off by default. Only routes with `pause_when_peer_offline: true` take part; `evuproxy serve` runs the probe loop, and with no such route it probes nothing. All fields below are optional and global.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `failures_to_pause` | int | `3` | Consecutive offline probes before the peer’s routes pause (1–100). |
| `successes_to_resume` | int | `2` | Consecutive online probes before they resume (1–100). |
| `interval` | string | `15s` | Time between probes, as a Go duration (`5s` to `1h`). |
| `icmp_fallback` | bool | `false` | If `true`, ping the peer over the tunnel when its WireGuard handshake is stale. Turn on when peers can be quiet for long periods. |

**Effect of a pause:** each of the route's DNAT rules becomes a drop with the same match, so new traffic the route would have forwarded is dropped rather than sent to the offline peer or to anything listening on those ports on this host. Sources the route doesn't accept, because of `source_allow_cidrs` or an allow-mode geo set, aren't affected and are handled as they are while the route runs, so an [`input_allows`](#input_allows) entry on the same port stays reachable for them. It takes effect on the probe that pauses the route, and a resume restores the DNAT the same way. Only the `prerouting` chain of `table ip evuproxy` changes, in one nft transaction: there is no full reload, WireGuard isn't touched, and geo sets, CrowdSec bans and rate-limit state are kept. The route's other rules stay in place. Connections already tracked aren't cut off. The pause is recorded in the `serve` log and the event log (`route_auto_paused`, `route_auto_resumed`), and shown by the **Auto-paused** banner on Routes (from [`GET /auto-pause`](http-api.md#endpoints)).

**A full Apply while a route is paused** doesn't know about the pause. It renders every route from config, so the paused route's DNAT comes back, and the next probe removes it again if the peer is still offline. That leaves the DNAT in place for up to one `interval`, with no new event. This applies to every kind of Apply, including `evuproxy reload`, a revert and the reload at boot. Because a pause never reaches the generated ruleset, it doesn't show up as a pending change. If an Apply failed partway, the rules are left alone until a later Apply succeeds, and `serve` logs a warning.

**Each probe** gives one result per peer:

1. A handshake within the last 180 seconds (the same threshold as the Peers page) counts as online, with no ping.
2. A stale or missing handshake counts as offline, unless `icmp_fallback` is on. Then a ping reply counts as online and no reply as offline. A peer that blocks ICMP behaves the same as with the fallback off.
3. If `wg show` can’t be read at all, the round isn’t counted either way, so a paused route stays paused and a running route keeps running.

**Timing:** the failure count only starts once the handshake is stale, so with the defaults a route pauses about 45 seconds after that, up to about 3 minutes 45 seconds after the peer’s last handshake. It resumes about 30 seconds after the peer returns. A result of the other kind resets the count, so a flapping peer doesn’t change state.

**Pause state is runtime-only:**

- It is tracked per peer and never written to `config.yaml`. `disabled` stays your setting: a disabled route is never reported as paused and never re-enabled.
- After `serve` restarts, every route starts as not paused, and the first probe runs one interval later. That probe restores any DNAT the previous process removed. While `serve` is stopped, a paused route stays closed until `serve` is back or an Apply runs.
- Turning `pause_when_peer_offline` off, or disabling the route, clears its pause.
- Changes take effect after **Apply**, because the loop reads the last applied config (**`config.yaml.bak`**) rather than pending edits. With [confirm mode](#confirm-or-revert-apply) on, that means once the Apply is confirmed. With no usable **`config.yaml.bak`**, it reads **`config.yaml`**. Thresholds and `interval` are picked up without a restart.

---

## `geo`

Controls whether forwarded traffic is filtered by source country using downloaded **IPDeny** zones (allow the listed countries, or block them, depending on `mode`).

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool | If `false`, geo sets are not required and forwarding rules accept any source (subject to normal firewalling). |
| `mode` | string | `allow` (default) or `block`. **`allow`**: only sources in the listed countries may reach forwarded ports (everything else is dropped). **`block`**: sources in the listed countries are dropped and all other sources pass. Applies to forwarded traffic, and to `input_allows` when `apply_to_input_allows` is set. |
| `set_name` | string | nftables set name for IPv4 sources (default `geo_v4` when `enabled`). |
| `countries` | list of strings | Lowercase ISO country codes (e.g. `se`, `no`). Required when `enabled` is true. |
| `zone_dir` | string | Directory where per-country zone files are stored (e.g. `/etc/evuproxy/geo-zones`). Required when `enabled` is true. |
| `apply_to_input_allows` | bool | If `true` and `enabled` is true, **`input_allows`** use the same geo allow/block logic as forwarded ports. Default **`false`**: **`input_allows`** stay plain INPUT accepts (SSH, HTTP, etc. remain reachable from any IPv4 source regardless of country lists). In the admin UI this toggle is on the **Geoblocking** page (**Countries &amp; rules** tab), not behind **Advanced mode**. Geo rules use **`ip saddr`** (IPv4 only); IPv6 to the same TCP/UDP ports is not matched by those lines and may hit the chain **policy** (often **drop**)—plan separate rules if you need IPv6 admin access. **`network.admin_tcp_ports`** are still emitted as unconditional TCP accepts after **`input_allows`**; they are **not** wrapped by this option—avoid duplicating sensitive ports there if you expect geo to cover them. |
| `break_glass_cidrs` | list of strings (optional) | IPv4/CIDR sources that **always pass** geo filtering on INPUT and forward paths. Use sparingly for operator escape hatches. |

When `geo.enabled` is true, `evuproxy reload` / `update-geo` expect zone files under `zone_dir`; empty or missing zones can block traffic when geo is enabled.

---

## `crowdsec`

Top-level key (a sibling of `forwarding` and `geo`, **not** nested under `forwarding`).

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | bool (optional) | Default `false`. When `true`, generated rules drop sources in nft set **`crowdsec_block_v4`** on published ports (after break-glass). Drops are logged with prefix **`evuproxy-crowdsec`** (visible in the admin **Logs** view, and in **Stats** nftables counters when [`stats.drop_counters`](#stats) is on). Requires the [CrowdSec nftables bouncer](../contrib/crowdsec/README.md) on the same host. |

CrowdSec drops apply on **inet** INPUT/forward only (not **`ip` prerouting** before DNAT). Banned sources are still DNAT’d, then dropped in forward — functionally blocked. Early drop in prerouting is deferred (v2) if needed.

Ban set contents are preserved across `evuproxy reload` (elements, including timeouts, are snapshotted and re-added after the tables are replaced).

---

## `stats`

Top-level key. Optional additions to the generated ruleset for the admin **Stats** page.

| Field | Type | Description |
|-------|------|-------------|
| `drop_counters` | bool (optional) | Default `false`, which leaves generated rules unchanged. When `true`, every explicit `drop` rule gets an nft **`counter`**: global and per-route deny lists, geo, CrowdSec, rate limits (on **inet** input/forward and **ip** prerouting where they exist) and the forward catch-all. **Stats** and `GET /api/v1/stats` (`nftables_counters`) then list each rule with its packet and byte counts. |

```yaml
stats:
  drop_counters: true
```

How to read the counts:

- **Counters reset on apply.** `evuproxy reload` replaces the tables, so the counts start from zero after each apply. `evuproxy update-geo` only reloads the geo sets and keeps them.
- **Packets, not log lines.** Geo and forward catch-all rules limit how often they log, but their counters include every packet they drop, so the counts will usually be higher than the matching lines in **Logs**.
- **Chain policy drops are not counted.** Traffic that matches no rule and falls through to the **input** or **forward** chain `policy drop` has no rule to count on. Unsolicited traffic to closed ports on the host is the usual example. The forward catch-all does count most of what would otherwise reach the forward policy.
- **Where a drop shows up depends on the path.** Deny lists and geo `block` mode drop forwarded ports in **ip** prerouting first, so those rows usually carry the counts and the matching **inet** rows stay near zero.

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

After editing `config.yaml`, run **`evuproxy reload --config /etc/evuproxy/config.yaml`** (or use the HTTP API) so WireGuard and nftables are regenerated. A reboot doesn't do this for you when [confirm mode](#confirm-or-revert-apply) is on. The admin UI can edit and save via **`PUT /api/v1/config`** (YAML is rewritten from the structured config; comments and unknown keys are not preserved).

### Confirm or revert (`apply`)

```yaml
apply:
  confirm: true
  confirm_timeout_seconds: 60
```

| Field | Type | Meaning |
|-------|------|---------|
| `confirm` | bool (optional) | If `true`, the web UI's **Apply** reverts by itself unless you confirm it in time. Left out or `false`: Apply is one-way, and a lockout risk needs an acknowledgement. |
| `confirm_timeout_seconds` | int (optional) | How long to wait, **10** to **3600**. Default **60**. |

[`config/evuproxy.example.yaml`](../config/evuproxy.example.yaml) turns it on, so new installs have it. Upgrading leaves an existing `config.yaml` alone, so existing installs keep a one-way Apply until you turn it on, with this setting or under **Settings → Preferences**. The web UI and the boot unit read this setting. **`evuproxy reload`** and **`POST /api/v1/reload`** are one-way unless each call asks otherwise, so scripts behave as before. The setting takes effect from the next Apply.

**At boot:** **`evuproxy.service`** runs **`evuproxy reload --boot`**, at every boot and every **`systemctl restart evuproxy`**. Nobody is there to confirm then, so if the last applied config (**`config.yaml.bak`**) has **`confirm: true`**, that config is what goes live, and any edits stay in **`config.yaml`** as unapplied changes.

| At boot | What goes live |
|---------|----------------|
| Last applied config has **`confirm: true`** | That config. **`config.yaml`** isn't touched, and if it differs, the journal warns. This includes an edit that turns **`confirm`** off, a failed Apply's edits, and **`peer-add`** or **`peer-remove`** without **`--apply`**. |
| Last applied config has **`confirm`** off or left out | **`config.yaml`**, as it always has. An edit that only turns **`confirm`** on is applied too. |
| **`config.yaml.bak`** is missing, invalid or not what was last applied, as on a first boot | **`config.yaml`**, with a warning in the journal, because the alternative is a host with no firewall. |
| The last applied config fails to apply | Nothing else is tried: **`evuproxy.service`** fails and the error is in its journal. It doesn't fall back to the unconfirmed edits. |

So with confirm on, editing **`config.yaml`** by hand and rebooting no longer applies the edit, and this also holds back edits that tighten security: a peer you removed keeps its access until you apply. To apply edits, run **`evuproxy reload`** (one-way) or **`evuproxy reload --confirm-within 60s`**, or use **Apply** in the UI. To see what is waiting, use **Pending changes** in the UI or compare **`config.yaml`** with **`config.yaml.bak`**.

**Geo updates:** **`evuproxy update-geo`**, **`evuproxy-geo.timer`** and **Update geo lists** in the UI follow the same rule, because a geo update has no revert timer either. With **`confirm: true`** in **`config.yaml.bak`**, they refresh the zones and sets of that config. Unapplied changes to **`geo.countries`** or a route's **`geo_countries`** stay unapplied: zones only they need are downloaded so the next Apply can use them, but nothing loads them into the firewall until then. The journal warns and the UI says so. With **`confirm`** off, or no usable **`config.yaml.bak`**, they use **`config.yaml`** as they always have, so a saved country change does go live with the next update. While a confirm session exists (waiting, or a failed revert), they refuse: confirm or revert first. If the timer lands in that window, **`evuproxy-geo.service`** fails with that message and the next daily run refreshes as usual.

**`scripts/rebuild.sh --install`**, which **`scripts/update.sh`** runs, replaces an installed **`evuproxy.service`** that it recognizes as one we shipped, before **`update.sh`** restarts the unit. So the update that brings in **`--boot`** doesn't apply unconfirmed edits either. It reloads systemd but restarts nothing, so a live confirm window carries on. If you've changed that file, or a drop-in sets **`ExecStart`**, it leaves your version alone and warns unless it already has **`--boot`**. With a **`PREFIX`** other than the one the unit runs from, it warns and leaves the unit alone. **`scripts/install.sh`** always installs the current unit. Going back to an older binary needs the older unit too, because older binaries don't know **`--boot`** and **`evuproxy.service`** would fail.

Confirm mode needs **systemd** and an API running as **root**. Without them Apply stops with an error and changes nothing; turn the setting off to go back to a one-way Apply. It also needs a known-good config to go back to, so run **`evuproxy reload`** once first (a host that has booted with **`evuproxy.service`** enabled already has).

**How it works:** before touching the firewall, the Apply arms a transient systemd timer that runs **`evuproxy reload-revert`**. The timer is independent of the API, so a stopped API or a change that cuts your connection doesn't stop it. A revert restores **`config.yaml`** and the **`.bak`** history to how they were before the Apply and re-runs the normal reload. The rejected config is kept as **`config.yaml.reverted`**, so the next **`evuproxy reload`** doesn't apply it again.

| Situation | What happens |
|-----------|--------------|
| Confirmed | Stops the timer. The Apply becomes the new last confirmed config. Connections the firewall already accepted can outlive the change. The web UI's nginx closes every connection after one response, so **Keep changes** needs a new connection and fails if the change blocks new connections to the UI. Nothing checks this for **`evuproxy reload-confirm`** in an open SSH session, for **`POST /apply/confirm`** sent straight to the API, or for the UI reached through an SSH tunnel or a reverse proxy on the same host, since those keep working over a connection opened earlier: try a new connection before confirming. |
| Time runs out | Reverts. |
| Apply again in the window | Restarts the wait. The revert target stays the last confirmed config. |
| One-way reload in the window | Refused: **`evuproxy reload`** exits with an error and **`POST /reload`** answers **409**, because the timer would silently undo it. **`systemctl restart evuproxy`** fails the same way. **`peer-add --apply`** and the like are refused the same way, after saving. So is **`POST /restore`** / **`evuproxy restore`**. |
| API restart in the window | Nothing changes: the session is on disk and the timer keeps running. If **`systemctl`** can't say whether the timer is armed, the session stands, and a one-way reload stays refused. |
| Reboot in the window | Transient timers don't survive a reboot, so **`evuproxy reload --boot`** at boot (or **`evuproxy serve`** at startup) reverts first. The session records its boot, so this doesn't depend on **`systemctl`** answering. |
| An Apply fails in the window | Reverts the host straight away, and leaves your edits in **`config.yaml`** as unapplied changes. |
| A revert fails | Tries three times, firewall before WireGuard, then records the failure in **`evuproxy reload-status`** and the audit events, and the UI shows it. **`config.yaml`** is already the baseline, so a reboot won't bring the rejected config back. A revert that was killed partway reads as failed too. Retry with **`evuproxy reload-revert`** or **`evuproxy reload`**. If the Apply itself had failed, **`evuproxy reload-revert`** puts your edits back in **`config.yaml`** as unapplied changes, while **`evuproxy reload`**, a reboot or an API restart keeps them in **`config.yaml.reverted`** with **`last_revert.reason`** **`failed_apply`**. |

| Command | What it does |
|---------|--------------|
| **`evuproxy reload --confirm-within 60s`** | Applies and waits for confirmation, whatever the setting says. |
| **`evuproxy reload-confirm`** | Keeps the Apply. |
| **`evuproxy reload-revert`** | Reverts now, or retries a revert that failed. |
| **`evuproxy reload-status`** | Prints any waiting Apply and the last revert as JSON. |

To bring back a rejected config by hand, copy **`config.yaml.reverted`** over **`config.yaml`**. The UI offers the same as **Restore as unapplied changes**. Backups leave session state out, so restoring one can't start a revert.

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
