# Playwright visual inspection (EvuProxy admin UI)

Headless screenshots of each primary sidebar route, against **`docker-compose.dev.yml`** (`http://127.0.0.1:9080`).

Prefer **Make** from the **repository root** (see root `Makefile`):

```bash
# One-time after clone / when package-lock.json changes
make playwright-deps

# Dev UI + mock API must be up (`make up` from repo root)
make playwright-visual
```

Environment (optional):

| Variable           | Default                 | Meaning                                                                     |
|--------------------|-------------------------|------------------------------------------------------------------------------|
| `BASE_URL`         | `http://127.0.0.1:9080` | UI origin                                                                   |
| `API_TOKEN`        | `dev`                   | Saved to `localStorage` as mock bearer token                                |
| `PW_VISUAL_SUBDIR` | `visual`                | Output subdirectory under `test-results/` (PNG filenames stay `<route>.png`). |

`make playwright-visual` runs a quick **`curl`** health check against `BASE_URL` first. Skip it with **`SKIP_PLAYWRIGHT_PING=1`** (e.g. restricted sandboxes).

## Prerequisites

Docker dev stack answering on **`BASE_URL`** (default `127.0.0.1:9080`): from repo root run **`make up`** before **`make playwright-visual`**.

Outputs:

- **Success:** `test-results/visual/<route>.png` (full page, one file per sidebar section).
- **Failures:** HTML report under `playwright-report/` (`npx playwright show-report` inside this directory).

### Before/after snapshots (sprint or PR)

With the dev UI up, capture the same routes into two folders:

```bash
cd devtools/playwright-visual
PW_VISUAL_SUBDIR=visual-sprint-before npx playwright test
# apply UI changes …
PW_VISUAL_SUBDIR=visual-sprint-after npx playwright test
```

Compare `test-results/visual-sprint-before/overview.png` vs `test-results/visual-sprint-after/overview.png` (same for `token`, `peers`, `routes`, `geoblocking`, `inbound`, etc.).

If **`docker compose`** shows an empty **`web/`** mount inside **evuproxy-ui** (HTTP 403 / blank pages), restart **`evuproxy-ui`** so the bind-mount picks up host files again.

Debugging:

```bash
cd devtools/playwright-visual
PWTRACE=1 npx playwright test --headed
```

See also [`docs/web-ui.md`](../../docs/web-ui.md).
