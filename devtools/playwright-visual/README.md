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

| Variable        | Default                 | Meaning                                      |
|-----------------|-------------------------|----------------------------------------------|
| `BASE_URL`      | `http://127.0.0.1:9080` | UI origin                                    |
| `API_TOKEN`     | `dev`                   | Saved to `localStorage` as mock bearer token |

`make playwright-visual` runs a quick **`curl`** health check against `BASE_URL` first. Skip it with **`SKIP_PLAYWRIGHT_PING=1`** (e.g. restricted sandboxes).

## Prerequisites

Docker dev stack answering on **`BASE_URL`** (default `127.0.0.1:9080`): from repo root run **`make up`** before **`make playwright-visual`**.

Outputs:

- **Success:** `test-results/visual/<route>.png` (full page, one file per sidebar section).
- **Failures:** HTML report under `playwright-report/` (`npx playwright show-report` inside this directory).

Debugging:

```bash
cd devtools/playwright-visual
PWTRACE=1 npx playwright test --headed
```

See also [`docs/web-ui.md`](../../docs/web-ui.md).
