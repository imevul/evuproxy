# EvuProxy roadmap

**Status as of 2026-11-01, audited against [v0.17.0](https://github.com/imevul/evuproxy/releases/tag/v0.17.0).** EvuProxy is in beta.

Phases 0–7 are shipped and running in production. Next is a second UI pass (Phase 7.5), followed by automated smoke and stress testing (Phase 8), so regressions are caught before they reach a live host.

| Phase | Theme | Status | Done | Open |
| ----- | ----- | ------ | ---- | ---- |
| [0](#phase-0--foundation) | Foundation | Shipped | 5 | 0 |
| [1](#phase-1--declarative-core) | Declarative core | Shipped | 10 | 0 |
| [2](#phase-2--local-api-and-logging) | Local API and logging | Shipped | 9 | 0 |
| [3](#phase-3--web-admin) | Web admin | Shipped | 8 | 0 |
| [4](#phase-4--hardening-and-release-tooling) | Hardening and release tooling | Shipped | 13 | 0 |
| [5](#phase-5--forwarding-policy-and-peers) | Forwarding policy and peers | Shipped | 15 | 0 |
| [6](#phase-6--abuse-resistance-and-observability) | Abuse resistance and observability | Shipped | 9 | 0 |
| [7](#phase-7--ui-rework-and-diagnostics) | UI rework and diagnostics | Shipped | 11 | 0 |
| [7.5](#phase-75--ui-second-pass) | UI second pass | **Next** | 0 | 16 |
| [8](#phase-8--test-automation-and-documentation) | Test automation and documentation | Planned | 5 | 6 |
| [9](#phase-9--route-runtime-and-traffic-metrics) | Route runtime and traffic metrics | Planned | 0 | 9 |
| [10](#phase-10--api-security) | API security | Planned | 0 | 5 |
| [11](#phase-11--packaging-and-upgrades) | Packaging and upgrades | Planned | 0 | 6 |
| [12](#phase-12--policy-and-ux-backlog) | Policy and UX backlog | Backlog | 0 | 9 |

## How to read this

- `[x]` means the feature exists in the code at v0.17.0.
- `[ ]` means it isn't done.
- *Proposed* marks an item that came out of this audit rather than from the spec, docs or earlier planning. Treat these as suggestions.
- The order of Phases 7.5–12 is a recommendation, not a commitment. Phases 0–7 group work by theme, so their release ranges overlap.

---

## Completed

### Phase 0 — Foundation

Repository layout and a safe baseline on a fresh VPS.

- [x] Repository layout: `cmd/`, `internal/`, `config/`, `templates/`, `scripts/`, `web/`, `docker/`, `contrib/`
- [x] [`scripts/install.sh`](scripts/install.sh) with package install through apt, dnf or pacman, `/etc/evuproxy`, and IP forwarding sysctl
- [x] [`scripts/uninstall.sh`](scripts/uninstall.sh), keeping `/etc/evuproxy` unless `PURGE=1` is set
- [x] systemd units for reload, API, geo refresh (service and timer), and metrics
- [x] Optional API enablement at install time, through a prompt or `EVUPROXY_INSTALL_API`

### Phase 1 — Declarative core

One YAML file drives WireGuard, nftables and geo, with no web stack needed.

- [x] YAML config as the single source of truth, validated on load and reload ([reference](docs/config.md))
- [x] WireGuard server config generation
- [x] nftables generation for the `inet evuproxy` and `ip evuproxy` tables, with geo sets kept in both
- [x] `evuproxy reload`, checking rules with `nft -c` before applying them
- [x] `evuproxy update-geo`, with spaced IPDeny downloads and a daily timer
- [x] Geo **allow** and **block** modes
- [x] `forwarding.routes[]` with TCP, UDP or both, plus port lists and ranges
- [x] `input_allows` for services on the same host
- [x] `disabled` flags on peers, routes and input rules
- [x] `evuproxy status`, and boot ordering across services

### Phase 2 — Local API and logging

A machine interface for the UI and automation.

- [x] `evuproxy serve` on `127.0.0.1:9847` by default, with bearer or `X-API-Token` auth
- [x] `GET`/`PUT /config`, plus `/preferences` for UI helper state
- [x] `POST /reload` and `POST /update-geo`
- [x] `/status`, `/overview`, `/metrics`, `/stats`, `/logs` and `/about`
- [x] `GET /pending`, comparing config on disk with the last apply
- [x] Firewall drop visibility through nftables `log` prefixes and `/logs`
- [x] Optional CORS with an explicit origin list, and a warning for `*` on non-loopback binds
- [x] Structured JSON file logs through `EVUPROXY_LOG_DIR`
- [x] Audit events in `state/events.jsonl`, exposed through `GET /events`

### Phase 3 — Web admin

A Docker-only static UI that is a thin client over the API.

- [x] Docker image and compose file, with nginx proxying to the loopback API
- [x] Token gate, Overview and Settings
- [x] Peers page with onboarding, and Routes editor
- [x] Geoblocking page with per-country zone statistics
- [x] Stats and Logs pages, with client-side log filtering and date filters
- [x] Pending changes page with a diff, Apply, Discard and Restore previous
- [x] Topology graph with pan and zoom
- [x] Mock API dev stack ([`docker-compose.dev.yml`](docker-compose.dev.yml))

### Phase 4 — Hardening and release tooling

- [x] `evuproxy backup` and `restore`, plus API endpoints limited to an allowlisted directory
- [x] Restore protection against path traversal and symlinks
- [x] Multi-peer routing, with `route_port_overlap` rejecting ambiguous public ports
- [x] Applied config history (`config.yaml.bak`, `.bak.1`–`.bak.5`), `discard-pending` and `restore-previous-applied`
- [x] Serialized mutating API calls, and a cross-process lock shared with the CLI
- [x] Timeouts on privileged subprocesses and on the API HTTP server
- [x] Atomic nftables replacement that rolls back on failure and never leaves the policy-drop chain removed
- [x] Fail-closed geo: a missing or invalid zone file aborts the reload
- [x] Input validation against injection into WireGuard config, and of downloaded zone lines
- [x] [`scripts/update.sh`](scripts/update.sh) for installs from a git clone
- [x] CI with `gofmt`, `go vet`, `go test -race` and ShellCheck
- [x] Release Please releases with Linux `amd64` and `arm64` binaries, and `SHA256SUMS`
- [x] [Security and privacy](docs/security-and-privacy.md) and [third-party data](docs/third-party-data.md) docs

### Phase 5 — Forwarding policy and peers

Mostly v0.7–v0.12.

- [x] `port_maps`, mapping public ports to different internal ports
- [x] Global and per-route source deny lists, and per-route allow lists
- [x] Per-route geo: `inherit`, `off` or `custom`
- [x] `forwarding.maintenance_mode`, with a toggle on Overview
- [x] `geo.break_glass_cidrs`, with Add detected IP in the UI
- [x] Optional geo enforcement on `input_allows`
- [x] `evuproxy validate` and `POST /validate`: a dry run with no apply and no `.bak` changes
- [x] Lockout warnings (`lockout_risk_*`) and `GET /client-ip`
- [x] `evuproxy peer-add`, `peer-remove` and `peer-set`
- [x] Peer QR codes
- [x] Server-side keypair generation as a fallback when Web Crypto is unavailable over plain HTTP
- [x] Encrypted EVUB onboarding bundles through [`install-peer-tool.sh`](scripts/install-peer-tool.sh), with HTTPS-only URL overrides
- [x] SQLite peer latency collector (`evuproxy metrics`) and `GET /metrics/peers`
- [x] On-demand route test (`POST /routes/test`)
- [x] Operator notes (`config-notes.txt`), and config upload with a side-by-side preview

### Phase 6 — Abuse resistance and observability

Mostly v0.12.

- [x] Global and per-route rate limits: `tcp_syn_per_second`, `max_conn_per_ip`, `udp_per_second`
- [x] Optional CrowdSec integration through `crowdsec_block_v4`, with bans preserved across reloads
- [x] CrowdSec install tooling for Docker and native setups ([guide](contrib/crowdsec/README.md))
- [x] CrowdSec and rate-limit drops in the Logs view
- [x] Optional Prometheus listener, off by default and loopback-only unless overridden
- [x] Optional GeoLite2 country flags in logs
- [x] Overview "Needs attention" list, last apply activity and geo freshness
- [x] CSV export for events and peer metrics
- [x] Backup, restore and raw `config.yaml` download in Settings

### Phase 7 — UI rework and diagnostics

v0.14–v0.17.

- [x] Evu Theme adoption with light, dark and system color schemes
- [x] Modal stacking, focus management, landmarks and table semantics
- [x] Density and information architecture pass
- [x] Pre-apply check in the UI that requires acknowledging lockout risks (client-side only: see [Phase 10](#phase-10--api-security))
- [x] Geo IP check: preview whether an IP would be allowed or blocked (`POST /geo/check-ip`)
- [x] Add a break-glass entry directly from a geoblock row in Logs
- [x] Confirmation before removing a route or inbound rule, and an offer to disable dependent routes when disabling or removing a peer
- [x] Playwright screenshots, behavior tests and axe-core accessibility checks, run locally through `make`
- [x] Guard against systemd-networkd or netplan wiping the tunnel address (`ensure-wg-networkd`), with host warnings
- [x] WireGuard endpoint DNS warnings (`wg_endpoint_host_mismatch`, `wg_endpoint_dns_lookup_failed`)
- [x] Diagnostics bundle with secrets redacted: CLI, `GET /diagnostics.md` and Settings

---

## Not completed

### Phase 7.5 — UI second pass

**Goal:** make the admin UI feel responsive and safe to use, not just correct: no lost work, immediate feedback, and an Apply you can trust.

Stop losing work:

- [ ] Detect conflicting saves with a config revision (`If-Match`, 409), since a stale tab can currently overwrite newer changes
- [ ] Warn before Escape or navigation discards edits in dialogs and on the Geoblock page
- [ ] Clear connection-lost state with a retry and automatic recovery, keeping the last data marked as stale

Undo, feedback and saving:

- [x] Add press feedback, motion tokens, a toast and a redesigned checkbox to Evu Theme, then re-vendor it
- [ ] Toast system, with visible feedback for every save, including enable and disable switches
- [ ] Replace confirmations on draft edits with immediate action and Undo
- [ ] One save model: switches save instantly, dialogs and page forms save explicitly (with at most one save bar per page), and host actions stay separate
- [ ] Switch pages immediately and show loading states, so slow links don't feel unresponsive
- [ ] One vocabulary across the UI: Save, Apply and Refresh

Apply flow:

- [ ] Plain-language list of pending changes with per-item Revert, with the raw nftables diff collapsed beneath it
- [ ] Unapplied-changes bar on every page, and a single Apply action that checks first and shows progress
- [ ] Warn when a change would disable inbound access for the current connection

Polish and reach:

- [ ] Motion and hierarchy pass: modal transitions, primary buttons for main actions, readable times and byte counts, first-run guide, page titles and a favicon
- [ ] Better at scale: sticky headers and sorting, a larger-topology view, and optional route names
- [ ] As phone-friendly as possible without affecting desktop, with row actions reachable on mobile

Last:

- [ ] Apply with automatic rollback unless confirmed, like Junos `commit confirmed`

### Phase 8 — Test automation and documentation

**Goal:** catch regressions automatically, without relying on a production host to find them.

**Done when:** UI, smoke and stress tests run automatically, in CI or a disposable VM.

Automation:

- [x] `nft -c` syntax tests in CI
- [ ] Run the Playwright behavior and axe-core suites in CI against the mock stack
- [ ] Decide whether to add a visual regression baseline, weighing test flakiness against value
- [ ] Automated smoke test: tunnel up, TCP and UDP forward, geo on and off, narrow peer `AllowedIPs` still reaching the LAN
- [ ] Automated forwarding policy tests: port maps, deny and allow lists, break-glass, route geo, maintenance mode
- [ ] Automated stress tests: rate limits and CrowdSec drops under load, with legitimate traffic still getting through
- [ ] *Proposed:* add tests for `internal/geoip`, `internal/logging` and `cmd/evuproxy`, which have none

Documentation fixes:

- [x] [`docs/web-ui.md`](docs/web-ui.md) describes the light, dark and system color schemes
- [x] [`README.md`](README.md), the [`Makefile`](Makefile) and [`scripts/rebuild.sh`](scripts/rebuild.sh) state Go 1.25+, matching [`go.mod`](go.mod)
- [x] [`docs/README.md`](docs/README.md) links to this roadmap instead of the gitignored `local_docs/`
- [x] [`CHANGELOG.md`](CHANGELOG.md): the stale `[Unreleased]` section is folded into 0.13.0, where that work shipped

### Phase 9 — Route runtime and traffic metrics

**Goal:** pause routes automatically when a peer is offline, and show traffic per route.

Accepted-traffic counters, which depend on the spike:

- [ ] Spike: on a host with real traffic, confirm counters can be tied to accepted forwards per route without counting scan drops. Record go or no-go
- [ ] If go: per-route accepted counters in `GET /stats`
- [ ] If go: an **Accepted** column on Routes, with its meaning documented
- [ ] If go, *proposed:* per-route accepted counters in Prometheus

Auto-pause:

- [ ] Decide between a runtime-only pause and changing `disabled` in YAML, and set the hysteresis (for example, 3 failures to pause and 2 successes to resume)
- [ ] Pause loop and a per-route `pause_when_peer_offline` setting
- [ ] Omit DNAT for paused routes, without a full reload if possible
- [ ] Routes checkbox and an **Auto-paused** banner

Drop visibility:

- [ ] Optional `counter` on selected drop rules. Generated rules have none today, so the Stats nftables table is empty on a standard install and drop counts only appear in Logs

### Phase 10 — API security

**Goal:** reduce the damage a single leaked token or a script on the UI origin can do. Today one token grants full admin access.

- [ ] Server-side apply gate: `/validate` returns the evaluated config hash, and `/reload` answers 409 without a matching acknowledgement, with an explicit `force` for automation. This closes the gap where another tab, operator or the CLI saves config between the check and the reload
- [ ] Strict Content-Security-Policy for the static UI
- [ ] CSRF hardening beyond bearer tokens
- [ ] Separate read and write API tokens (earlier planning deferred this indefinitely, so it needs a decision)
- [ ] Optional mTLS or stronger API auth

### Phase 11 — Packaging and upgrades

**Goal:** make installs and upgrades reproducible, and less dependent on a git clone.

- [ ] Build and publish the UI image in CI (today it is only built locally)
- [ ] Pin the `nginx` base image by digest
- [ ] Optional `.deb` and RPM packages
- [ ] *Proposed:* an upgrade path for binary-only installs, which `update.sh` doesn't cover
- [ ] *Proposed:* config migration or upgrade checks, since `update.sh` doesn't migrate or validate `config.yaml`
- [ ] Log reopen on `SIGHUP` for logrotate

### Phase 12 — Policy and UX backlog

Independent items, to pick up as needed.

- [ ] CrowdSec early drop in `ip` prerouting. Banned sources are still blocked today, but only after DNAT
- [ ] CIDR presets for route allow lists
- [ ] Scheduled route windows
- [ ] Dedicated REST resources for peers, which are currently edited through `PUT /config`
- [ ] YAML in config upload, which currently accepts JSON only
- [ ] Link from the disabled-peer error to the affected routes
- [ ] A higher `GET /events` limit for CSV export
- [ ] *Proposed:* a configurable geo zone source. The URL is hard-coded to IPDeny, although [`docs/security-and-privacy.md`](docs/security-and-privacy.md) mentions "your configured source"
- [ ] *Proposed:* IPv6 support for forwarding, geo and rate limits, which are IPv4-only today

---

## Non-goals

- Layer-7 proxying, such as HTTP routing or TLS termination as the core product
- Replacing general-purpose reverse proxies or panels
- Guaranteeing geo accuracy beyond public IP-to-country data
- Treating geo filtering as legal or sanctions compliance
- All-packet logging of high-volume traffic
