# Optional CrowdSec integration

**Audience:** VPS operators running EvuProxy who want **optional** automated IP blocking via [CrowdSec](https://www.crowdsec.net/). This is operator documentation — not a developer-only test harness. The stack is suitable for production when you tune acquisition, Hub collections, and monitoring; the install script automates the default Docker path on the same host as EvuProxy.

EvuProxy drops WAN sources listed in nftables set **`crowdsec_block_v4`** when `crowdsec.enabled: true`. CrowdSec (separate software) reads logs, decides which IPs to ban, and a **bouncer** writes those IPs into the kernel set.

```
  host journal ──► CrowdSec (Local API) ──► ban decisions
                           ▲
                           │ API key
                    nftables bouncer ──► crowdsec_block_v4 @ inet evuproxy
                           ▲
                    EvuProxy reload ──► INPUT / forward drop rules
```

**Off by default** — not installed by `scripts/install.sh`.

---

## Quick install (recommended)

On the **EvuProxy host**:

```bash
make crowdsec-install
# or: ./contrib/crowdsec/install.sh
```

The installer will:

1. **Check EvuProxy config** for `crowdsec.enabled: true` (offer to enable + `evuproxy reload`).  
2. **Ask how to run CrowdSec** — **Docker** (default) or **native** (systemd packages). Set `CROWDSEC_INSTALL_MODE=docker|native` to skip the prompt.  
3. Install acquisition config, Hub collection, bouncer API key, and start services.

**Docker path:** `acquis.yaml`, `docker-bouncer.yaml`, `.env`, compose stack (bouncer image built locally).  
**Native path:** `/etc/crowdsec/acquis.d/evuproxy.yaml`, `/etc/evuproxy/crowdsec-bouncer.key`, bouncer yaml (see [`native-bouncer.yaml.example`](native-bouncer.yaml.example)).

Non-interactive EvuProxy enable: `CROWDSEC_INSTALL_YES=1`. Example full auto Docker install:

```bash
CROWDSEC_INSTALL_YES=1 CROWDSEC_INSTALL_MODE=docker make crowdsec-install
```

**Other commands:**

| Command | Purpose |
|---------|---------|
| `make crowdsec-install` | First-time setup (config, bouncer key, start stack) |
| `make crowdsec-up` | Start stack again after `crowdsec-down` or host reboot |
| `make crowdsec-status` | Containers, bouncers, decisions, nft set |
| `make crowdsec-down` | Stop stack (keeps data volume) |
| `make crowdsec-logs` | Follow container logs |

---

## Files in this directory

| File | Purpose |
|------|---------|
| [`install.sh`](install.sh) | Automated install / status / down (checks EvuProxy config) |
| [`evuproxy-enable-crowdsec.py`](evuproxy-enable-crowdsec.py) | Helper: set `crowdsec.enabled: true` in config (used by install) |
| [`acquis.yaml.example`](acquis.yaml.example) | Log sources (copied to `acquis.yaml` by install) |
| [`docker-compose.example.yaml`](docker-compose.example.yaml) | Docker: CrowdSec + locally built nft bouncer (`Dockerfile.bouncer`) |
| [`docker-bouncer.yaml.example`](docker-bouncer.yaml.example) | Docker bouncer config (copied to `docker-bouncer.yaml` by install) |
| [`Dockerfile.bouncer`](Dockerfile.bouncer) | Packages prefetched `vendor/` binary into `evuproxy-crowdsec-firewall-bouncer:local` |
| [`native-bouncer.yaml.example`](native-bouncer.yaml.example) | Native nft bouncer config template (table/set for EvuProxy) |
| [`.env.example`](.env.example) | Docker: bouncer API key template (install writes `.env`) |
| [`.install-mode`](.install-mode) | Legacy copy beside this directory (gitignored) |
| `/etc/evuproxy/crowdsec-install-mode` | Host canonical install mode: `docker` or `native` |

---

## Before you install

- **Same machine** as EvuProxy — the bouncer must update **host** nftables.  
- **Docker + Compose v2** for the Docker install path, **or** CrowdSec + nft bouncer **packages** for native.  
- **systemd journal** on the host (default on most VPS images).  
- EvuProxy **`evuproxy`** binary on PATH (or `/usr/local/bin/evuproxy`) if the installer should reload for you.  
- EvuProxy table **`inet evuproxy`** with set **`crowdsec_block_v4`** (installer can enable + reload; empty set is OK until the bouncer runs).

---

## Verify it works

After install:

```bash
make crowdsec-status
```

**Optional smoke test** — add a temporary ban (replace with a test IP you control):

```bash
cd contrib/crowdsec
docker compose -f docker-compose.example.yaml exec crowdsec \
  cscli decisions add --ip 203.0.113.99 --duration 15m --reason "connectivity test"
sudo nft list set inet evuproxy crowdsec_block_v4
```

If `cscli` reports `dial tcp 0.0.0.0:8080: connect: connection refused`, the CrowdSec
container was started without `LOCAL_API_URL` (older compose) or needs a restart after
updating `docker-compose.example.yaml`:

```bash
docker compose -f docker-compose.example.yaml up -d crowdsec
docker compose -f docker-compose.example.yaml exec crowdsec cscli lapi status
```

From that IP, a **published forward port** should be dropped (unless the IP is in **break-glass** CIDRs). Remove the test:

```bash
docker compose -f docker-compose.example.yaml exec crowdsec \
  cscli decisions delete --ip 203.0.113.99
```

Real bans usually come from Hub **scenarios** (e.g. repeated failed SSH). EvuProxy-specific kernel log lines are **acquired** but need custom Hub parsers/scenarios for automated bans from `evuproxy-ratelimit:` logs.

---

## Manual setup

Use this if you prefer not to run `install.sh`, or need to debug step by step.

<details>
<summary>Manual Docker steps (click to expand)</summary>

Run from **`contrib/crowdsec/`**.

### 1. EvuProxy

Enable CrowdSec in config / UI and `sudo evuproxy reload`. Confirm:

```bash
sudo nft list set inet evuproxy crowdsec_block_v4
```

### 2. Acquisition and bouncer config

```bash
cp acquis.yaml.example acquis.yaml
cp docker-bouncer.yaml.example docker-bouncer.yaml
```

Includes SSH (`ssh.service`) and kernel lines matching `evuproxy-` (see [`acquis.yaml.example`](acquis.yaml.example)).

### 3. Start CrowdSec

```bash
docker compose -f docker-compose.example.yaml up -d crowdsec
docker compose -f docker-compose.example.yaml exec crowdsec cscli collections install crowdsecurity/linux
```

### 4. Bouncer API key

CrowdSec’s **Local API** (LAPI) listens on `127.0.0.1:8080` in the default compose file. Create a bouncer and save the **one-time** key:

```bash
docker compose -f docker-compose.example.yaml exec crowdsec \
  cscli bouncers add evuproxy-nft-bouncer -o raw
```

Copy output into `.env`:

```env
CROWDSEC_BOUNCER_KEY=paste-key-here
CROWDSEC_LAPI_URL=http://127.0.0.1:8080
```

### 5. Build and start bouncer

```bash
docker compose -f docker-compose.example.yaml build crowdsec-firewall-bouncer
docker compose -f docker-compose.example.yaml up -d crowdsec-firewall-bouncer
```

</details>

---

## After `evuproxy reload`

Every `evuproxy reload` **recreates** table `inet evuproxy` and **clears** `crowdsec_block_v4` until the bouncer repopulates it (usually seconds, native bouncer default poll **10s**). During an incident you may restart the bouncer:

```bash
docker compose -f docker-compose.example.yaml restart crowdsec-firewall-bouncer
# or native:
sudo systemctl restart crowdsec-firewall-bouncer
```

**Optional:** set **`EVUPROXY_CROWDSEC_BOUNCER_RESTART=1`** so `evuproxy reload` runs **`systemctl try-restart crowdsec-firewall-bouncer`** when `crowdsec.enabled` (native installs only; Docker restart is manual — see compose path above).

---

## Rule placement (EvuProxy)

Bans apply on published ports **after** break-glass and **before** rate limits / geo on **INPUT** and **inet forward**. The bouncer must use **`inet:evuproxy`** / set **`crowdsec_block_v4`** only (not the `ip` prerouting table).

---

## Acquisition notes

- **Acquisition** = which logs CrowdSec reads.  
- **Hub collections** = parsers + scenarios that create bans.  
- Without a collection, logs are ingested but **no bans** are created.

Example EvuProxy kernel line:

```text
kernel: evuproxy-ratelimit: IN=eth0 SRC=203.0.113.10 …
```

**Live journal:** compose mounts `/var/log/journal`, `/run/log/journal`, `/etc/machine-id`.  

**`--directory=/var/log/host/`** in some online examples is only for an **exported** journal copy, not the default mount — see commented stanza in `acquis.yaml.example`.

---

## Native install (no Docker)

Requires [CrowdSec](https://doc.crowdsec.net/docs/getting_started/install_crowdsec) and the [nftables bouncer](https://doc.crowdsec.net/docs/bouncers/nftables) packages on the host. Choose **native** when prompted by `install.sh`, or:

```bash
CROWDSEC_INSTALL_MODE=native make crowdsec-install
```

The script installs acquisition config, Hub collection, bouncer registration, and (if no existing bouncer config) writes `/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml` from `native-bouncer.yaml.example` with **set-only** mode targeting **`inet evuproxy` / `crowdsec_block_v4`**.

**Existing bouncer config:** If `/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml` already exists but does **not** target EvuProxy, install **fails** with instructions. Options:

- Merge manually using `native-bouncer.yaml.example`, then re-run install.
- **`CROWDSEC_FORCE_BOUNCER_CONFIG=1`** — backup the existing file and install the EvuProxy template.
- **`CROWDSEC_SKIP_BOUNCER_CONFIG=1`** — skip bouncer config (you manage CrowdSec elsewhere).
- If **fail2ban** or another tool owns the host nftables bouncer, use **Docker** instead: `CROWDSEC_INSTALL_MODE=docker make crowdsec-install`.

Store the API key in `/etc/evuproxy/crowdsec-bouncer.key` when merging manually.

---

## Troubleshooting

| Symptom | Things to check |
|---------|------------------|
| Install fails: missing key | Run `install.sh bouncer-key` or delete bouncer and re-run install (see script message) |
| Bouncer image build fails | `install.sh` downloads the binary on the **host** first (`vendor/`); image build is offline COPY-only. If download fails, check host DNS/curl to GitHub. Docker build DNS issues (`deb.debian.org`) should no longer block install. Native fallback: `CROWDSEC_INSTALL_MODE=native make crowdsec-install` |
| `cscli` / `0.0.0.0:8080` connection refused | Compose sets `LOCAL_API_URL=http://127.0.0.1:8080` on the `crowdsec` service; `docker compose up -d crowdsec` then `cscli lapi status` |
| Bouncer auth errors | `.env` key matches `cscli bouncers list`; LAPI at `http://127.0.0.1:8080` |
| No decisions | Hub collection installed; logs acquired (`cscli metrics show acquisition`) |
| Set always empty | Bouncer running with `NET_ADMIN`, `network_mode: host`; EvuProxy `crowdsec.enabled` + reload |
| Bans not on game port | IP not in break-glass; `sudo nft list ruleset \| grep crowdsec` |
| Reload cleared bans | Expected — wait for bouncer sync or restart bouncer |

---

## Without a bouncer

`evuproxy reload` with `crowdsec.enabled: true` still succeeds and creates an **empty** set. No CrowdSec-driven drops until a bouncer populates it.
