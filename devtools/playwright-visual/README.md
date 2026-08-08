# Playwright visual + accessibility checks (EvuProxy admin UI)

Headless screenshots and an axe-core gate for the admin UI, against **`docker-compose.dev.yml`** (`http://127.0.0.1:9080`).

Prefer **Make** from the **repository root** (see root `Makefile`):

```bash
# One-time after clone / when package-lock.json changes
make playwright-deps

# Dev UI + mock API must be up (`make up` from repo root)
make playwright-visual   # screenshots
make a11y                # axe-core gate
```

Both targets run a quick **`curl`** health check against `BASE_URL` first. Skip it with **`SKIP_PLAYWRIGHT_PING=1`** (e.g. restricted sandboxes).

Environment (optional):

| Variable           | Default                 | Meaning                                                      |
|--------------------|-------------------------|--------------------------------------------------------------|
| `BASE_URL`         | `http://127.0.0.1:9080` | UI origin                                                     |
| `API_TOKEN`        | `dev`                   | Saved to `localStorage` as mock bearer token                  |
| `PW_VISUAL_SUBDIR` | `visual`                | Output subdirectory under `screenshots/`                      |

## Screenshots (`make playwright-visual`)

Every surface is captured **twice — light and dark** — as `<name>-light.png` / `<name>-dark.png` under `screenshots/$PW_VISUAL_SUBDIR/`. The scheme is seeded into `localStorage` before first paint, so the FOUC guard in `index.html` already sees it and no theme flash is captured.

Captures deliberately do **not** live under `test-results/`: Playwright wipes that directory at the start of every run, so a baseline stored there is destroyed the next time any spec runs.

Captured surfaces (42 PNGs):

- **11 sidebar routes**, full page: overview, settings, token, peers, routes, topology, inbound, geoblocking, pending, stats, logs
- **Modals**: peer editor (each tab), route editor (default + Advanced), geo country picker, context help, confirm dialog, keyboard shortcuts

The route editor Advanced tab is gated behind Settings → Advanced mode, so that spec seeds `evuproxy_advanced_settings` too.

### Before/after snapshots (sprint or PR)

```bash
cd devtools/playwright-visual
PW_VISUAL_SUBDIR=visual-before npx playwright test smoke-visual
# apply UI changes …
PW_VISUAL_SUBDIR=visual-after npx playwright test smoke-visual
```

Compare e.g. `screenshots/visual-before/overview-dark.png` against `screenshots/visual-after/overview-dark.png`.

## Accessibility (`make a11y`)

Runs axe-core against WCAG 2.0/2.1 A and AA on all 11 routes in both schemes.

- **Fails** on `critical` and `serious` violations.
- **Logs** `moderate` / `minor` findings to the console without failing, so advisory rules stay visible but do not block.

Failure output lists the rule, the offending selectors, and a trimmed HTML snippet for each.

## Troubleshooting

If **`docker compose`** shows an empty **`web/`** mount inside **evuproxy-ui** (HTTP 403 / blank pages), restart **evuproxy-ui** so the bind-mount picks up host files again.

If Playwright reports a missing browser executable, check that `PLAYWRIGHT_BROWSERS_PATH` points at a populated cache (default `~/.cache/ms-playwright`).

```bash
cd devtools/playwright-visual
PWTRACE=1 npx playwright test smoke-visual --headed
```

Failures also write an HTML report to `playwright-report/` (`npx playwright show-report`).

See also [`docs/web-ui.md`](../../docs/web-ui.md).
