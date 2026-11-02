# Web UI (Docker)

The admin UI is intended to run **in Docker only**. From the repo root:

```bash
docker compose up --build
```

Browse `http://127.0.0.1:9080`. On a remote VPS, use an **SSH tunnel** instead of exposing the UI publicly. The UI container uses **host networking** so nginx can proxy `/api` to **`127.0.0.1:9847`** without binding the API on `0.0.0.0`. Override **`EVUPROXY_UI_LISTEN`** (e.g. `0.0.0.0:9080`) only for temporary LAN tests — the UI then listens on all interfaces; combine with firewall rules and treat the token like a password. **Host network is Linux-oriented**; use the dev mock stack on other setups if needed. Docker Compose defines an optional **`healthcheck`** against **`GET /healthz`** on the UI nginx port.

Production nginx sends **`Cache-Control: no-cache, private, must-revalidate`** for HTML and `/static/*` so a rebuilt UI image is picked up after a normal reload (without relying on hard refresh). Ensure **`evuproxy serve`** on the host is updated when API behavior changes (e.g. new JSON fields); `scripts/update.sh` restarts the API service and rebuilds the UI container when compose is in use.

See also [Security and privacy](security-and-privacy.md) and [Local HTTP API](http-api.md).

The sidebar has a **color scheme** menu (**Light**, **Dark**, or **System**, the default), saved in this browser. **Overview** shows recent **audit events** (from the API), geo list freshness when available, and a **Maintenance mode** toggle (sets `forwarding.maintenance_mode`; when on, no forward DNAT/accept rules are generated until you apply with it off again). **Settings** uses tabs (**Preferences**, **Notes & backups**, **Advanced**) and can download raw **`config.yaml`** from Preferences. **Peers** and **Routes** support a **header search** (press **`/`** to focus). **Peers**, **Routes** and **Inbound access** keep their column headers in view while a long list scrolls, and sort by clicking a header: ascending, descending, then back to config order. Sorting changes only what you see, never the order in config. **Routes** lead with the optional route **name** once any route has one, and include an on-host **Test** probe (TCP/UDP; UDP may be inconclusive). **Geoblocking** lists per-country zone statistics from the API and includes a **Check an IP** preview (dry-run against form rules via **`POST /api/v1/geo/check-ip`**). **Topology** shows a read-only graph of `forwarding.routes` from the EvuProxy host (ingress) to each target peer, using `GET /v1/stats` for WireGuard handshake-style edge coloring. From 16 routes it groups routes by peer, collapsed, at a readable zoom, with a filter and **Expand all** / **Collapse all**; scrolling then moves through the graph and Ctrl+scroll zooms.

**Backup & restore (Settings → Notes & backups):** create a config tarball via `POST /api/v1/backup` and restore one via `POST /api/v1/restore`. Paths must resolve under the API's backup allowlist directory (default `/var/backups`, override with `EVUPROXY_BACKUP_DIR` on the API service) — see [Local HTTP API](http-api.md). After a restore, review the config and **Apply** if needed.

**Replace config (upload):** Settings can upload a config **JSON** file; a modal shows the **current vs. uploaded** config side by side before anything is written. Saving replaces `config.yaml` on disk via `PUT /api/v1/config` (YAML comments are not preserved); the host keeps running the previously applied rules until you apply.

**Pending changes:** the Pending page lists each difference from the last applied config in plain language, such as "Removed route UDP 53 → laptop". **Revert** on a row takes that one change back out of the saved config and leaves the others in place; it has no time limit, unlike the Undo on a toast. The generated nftables **diff** (unified or split view) stays available in a collapsed section, and opens by itself when the applied config is not available to compare. The page also has **Check config**, **Discard pending**, and **Restore previous applied** actions, and an **Apply** for re-applying when nothing is waiting.

**Applying:** while changes are waiting, a bar above every page says how many, with **Review** and **Apply**; the Pending changes link in the sidebar shows the same count. **Apply** always checks first and shows named steps as it runs: Validating, Applying firewall, Applying WireGuard, Done. A failed check stops it. The result is pinned under the bar and stays through navigation until the config changes or you dismiss it. **Check config** on Pending changes runs only the check.

**Confirm or revert:** with **Revert Apply unless confirmed** on (Settings → Preferences, or [`apply.confirm`](config.md#confirm-or-revert-apply), on for new installs and off for existing ones), a panel above every page says "Applied. Keep these changes? Reverting in 60s", with **Keep changes** and **Revert now**. If you do nothing, or a change has cut you off, the host goes back to the last confirmed config by itself. That runs from a systemd timer on the host, so neither this page nor the API has to be working. Lockout risks stay on screen through the countdown, and there's nothing to tick. The firewall keeps connections it already accepted, so this page can go on working after a change blocks new ones; the panel says to check you can open a new connection before keeping. Applying again during the countdown restarts it and keeps the same config to go back to. The panel picks the countdown up after a page reload or an API restart, and if the API stops answering it says the host will revert by itself. With this on, a reboot applies the last confirmed config and leaves saved edits as unapplied changes; see [At boot](config.md#confirm-or-revert-apply).

After a revert, the panel says why and offers **Restore as unapplied changes**, which brings back what you applied so you can fix it and try again, or **Dismiss**, which forgets it. If a revert fails or is killed partway, the panel turns into a danger banner with the error and **Retry revert**, and Apply is blocked until it succeeds, since the host may still be running the rejected config. **Recent activity** shows **Kept applied config**, **Reverted Apply** and **Revert failed**.

With the setting off, Apply is one-way. If the check finds a lockout risk, Apply stops until you tick the acknowledgement and press it again; that re-runs the check, and a different set of warnings clears the tick.

## Save, Apply and Refresh

The UI uses one word for each operation:

| Word | What it does | API | CLI |
| ---- | ------------ | --- | --- |
| **Save** | Writes the draft: `config.yaml`, notes or preferences. The firewall and tunnel keep running as they were. | `PUT /api/v1/config` | Edit `config.yaml` |
| **Apply** | Changes the host: regenerates WireGuard and nftables from the saved config. | `POST /api/v1/reload` | `evuproxy reload` |
| **Refresh** | Re-reads what's on screen from the API. Nothing is written. | `GET` endpoints | |

**Apply** in the UI and `reload` in the API and CLI are the same operation. **Recent activity** on Overview shows Apply events as **Apply started**, **Applied config** and **Apply failed**. The stored events and the CSV export keep the API's codes (`reload_started`, `reload_ok`, `reload_failed`), and a failed Apply also shows its `reload_error` code. The API's `reload failed` error reads **Apply failed**, and a `geo_last_success_source` of `reload` reads **Source: Apply** in Overview's geo freshness.

## Saving

What a control does tells you whether it has saved:

| You're changing | Control | What happens |
| ---------------- | ------- | ------------ |
| One on/off setting | **Switch** | Already saved when you flip it. Config and preference switches show a toast with **Undo**; browser-only settings show nothing. A rejected switch snaps back with the error beside it. |
| One object with several fields | **Dialog** | Footer **Save**. On/off inside it is a checkbox. Closing with edits warns first. |
| A page of related settings | **Save bar** | **Geoblocking** and **Settings** have one bar each, covering all the page's tabs. It appears only while there are unsaved edits: **Unsaved changes · Discard · Save**. Leaving with edits warns first. Geoblocking's read-only **Zone files** tab hides the bar but keeps the edits. |
| A choice feeding a form | **Dialog** | **Done**, as in the country picker. Nothing is saved until the form is. |
| Something done to the host or files | **Named action** | **Apply**, **Update geo lists**, **Create backup**. |

Geoblocking's switches (**Enable geoblocking**, **Apply geoblocking to inbound allow rules**, **CrowdSec integration**) write only their own field, never the unsaved form, so enabling geoblocking is rejected if no country has been saved yet, even with countries picked in the form.

The Settings bar writes up to three separate stores: UI preferences, config (**Public interface**) and notes. Only the ones you changed are written. There is no transaction across them, so one can fail after another has landed: the bar stays up over what is left, names what was already saved, and **Save** retries only the rest.

**API token** is stored in this browser by **Connect**, which then reports whether the API accepted it.

## Stats page

**WireGuard peers** come from `wg show`. **nftables counters** lists only nft rules that include an explicit **`counter`** keyword (`GET /api/v1/stats` parses `nft list table … -a`).

Generated EvuProxy enforcement drops (geoblock, rate limits, CrowdSec, forward catch-all) use **`log prefix`** and **`drop`** — not **`counter`** — so hit counts show up on the **Logs** page (journal/dmesg), not in the Stats nftables table, even when those features are enabled and dropping traffic. Geoblock **SRC** cells offer a break-glass add control when that IPv4 is not already covered by **`geo.break_glass_cidrs`**.

**Deferred:** add optional **`counter`** on selected drop rules (or dedicated summary rules) so rate-limit and CrowdSec packet counts could also appear on Stats, in addition to log lines on Logs.

**Advanced mode** (Settings) **disables** the **Advanced** tab on **Routes** and **Geoblocking** in this browser (`localStorage`) until turned on — the tab stays visible with a hint linking to Settings. It does not gate **Apply geoblocking to inbound allow rules** — that control stays on the Geoblocking default tab. The **CrowdSec integration** toggle lives on the Geoblocking **Advanced** tab. When only one tab is actionable, the tab control uses subdued styling so the active segment reads as a section label, not a lone button.

## Local UI with mock API

To try the admin UI **without** `evuproxy serve` on the host (no WireGuard or nftables changes), use the dev stack: a stub API in Docker plus the same UI image, wired on the compose network.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open `http://127.0.0.1:9080` and enter API token **`dev`** (default), or set `MOCK_API_TOKEN` when starting compose and use that value in the UI. The mock implements the same HTTP paths and JSON shapes as the real API. **Config persistence (dev):** the mock writes successful `PUT /api/v1/config` (and discard/restore paths that rewrite config) to **`docker/mock-api/state/mock-config.json`** inside a bind-mounted volume so edits survive container restart. Delete that file (or run **`make dev-fresh`** from the repo root) to reset to the Python baseline in **`mock_server.py`**. The mock runs as the invoking user, so these files stay yours: `make` sets `UID`/`GID`, and if your ids aren't 1000 and you call compose directly, run `export UID GID=$(id -g)` first. A checkout that ran the stack while the mock still ran as root has root-owned files that block the pull, so run `sudo rm -rf docker/mock-api/state` before pulling this change, then pull as normal. If a pull or merge has already failed, run `sudo rm -rf docker/mock-api/state` and then `git status`. A failed fast-forward leaves the incoming files behind, while a failed merge commit leaves nothing to clean up. To clear them, run `git checkout -- .` (this discards all uncommitted edits in the checkout, so save any you want first) and delete any untracked files the pull added. Then pull or merge again. Synthetic **`GET /api/v1/stats`** `wireguard_peers` fields support the **Topology** page (Animated edges ≈ counter deltas in mock only).

**Live UI edits:** [docker-compose.dev.yml](../docker-compose.dev.yml) bind-mounts [web/](../web/) into the nginx container and [docker/mock-api/mock_server.py](../docker/mock-api/mock_server.py) into the mock container. Edit static files or the mock script on the host, **reload the browser** for UI changes, or run `docker compose -f docker-compose.dev.yml restart mock-api` after Python edits. Rebuild images only when [docker/Dockerfile](../docker/Dockerfile), [docker/nginx.conf](../docker/nginx.conf), or [docker/entrypoint.sh](../docker/entrypoint.sh) change. Dev nginx uses [docker/nginx.dev.conf](../docker/nginx.dev.conf) (`Cache-Control: no-store`, fixed upstream to `mock-api`).

**Playwright snapshots (layout review):** with the mock stack reachable on `127.0.0.1:9080`, from the repo root run **`make playwright-deps`** once then **`make playwright-visual`** ; see [devtools/playwright-visual/README.md](../devtools/playwright-visual/README.md).
