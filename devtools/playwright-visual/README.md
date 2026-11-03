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

Every surface is captured **twice — light and dark** — as `<name>-light.png` / `<name>-dark.png` under `screenshots/$PW_VISUAL_SUBDIR/`. The scheme is seeded into `localStorage` before first paint, so the FOUC guard (`web/static/js/theme-boot.js`) already sees it and no theme flash is captured.

Captures deliberately do **not** live under `test-results/`: Playwright wipes that directory at the start of every run, so a baseline stored there is destroyed the next time any spec runs.

Captured surfaces (48 PNGs):

- **11 sidebar routes**, full page: overview, settings, token, peers, routes, topology, inbound, geoblocking, pending, stats, logs
- **More page states**: geoblocking Advanced and Zones tabs, pending lockout gate
- **Modals**: peer editor (each tab), route editor (default + Advanced), geo country picker, context help, confirm dialog, keyboard shortcuts

The route editor Advanced tab is gated behind Settings → Advanced mode, so that spec seeds `evuproxy_advanced_settings` too.

## Visual baseline (`make visual-check`)

`baseline/` holds the expected image for each capture, plus `freeze-cache.json`, the API responses and fonts they were captured from. `make visual-check` captures the same surfaces and fails on any difference, at threshold 0.02 and tolerance 0. The default threshold of 0.2 missed the real change in ENG-134.

```bash
make visual-check      # compare; on failure, see screenshots/visual-diff/
make visual-baseline   # refresh the cache and rewrite the images that changed
```

Both need only Docker. They run in the `mcr.microsoft.com/playwright` image set in `docker-compose.visual.yml`, on a separate stack with no published port, so they don't touch `make up` or its mock state. **Don't capture a baseline any other way:** native runners failed every set measured on ENG-148, because other fonts render differently.

**After an intended UI change**, run `make visual-baseline`, look through the changed images in `git diff`, and commit them with the change. Only images over the threshold are rewritten, so a re-approval adds as little to the repository as it can. Even on unchanged code, expect the `stats` and `modal-confirm` images to be rewritten, since the mock's byte counters and backup time keep moving. Every rewritten PNG stays in git history, so avoid regenerating more often than you need to.

**After bumping Playwright**, update the image tag in `docker-compose.visual.yml` to the locked version and regenerate.

**Keep the cache fresh.** Pages render from `freeze-cache.json`, not from the mock, so a stale cache hides changes: after changing the API, the mock's data, or what the UI requests, the screenshots still show the old responses until you run `make visual-baseline`. It always records the cache from scratch on a freshly started mock.

**Failures:**

- *An image differs:* `screenshots/visual-diff/` has `<name>-actual.png`, `<name>-expected.png` and `<name>-diff.png`. In CI these are in the `playwright-visual-baseline` artifact.
- *A request is missing from the cache:* the test fails and names the key, such as `GET http://127.0.0.1:8080/api/v1/new `. The request is blocked, not fetched, because live mock data would bring the flakiness back. Only `make visual-baseline` fills the cache.

The cache is keyed by full URL, including the port. Both commands reach the UI as `http://127.0.0.1:8080` from inside its container's network, so that is the same everywhere.

### Before/after snapshots (sprint or PR)

```bash
cd devtools/playwright-visual
PW_VISUAL_SUBDIR=visual-before npx playwright test smoke-visual
# apply UI changes …
PW_VISUAL_SUBDIR=visual-after npx playwright test smoke-visual
```

Compare e.g. `screenshots/visual-before/overview-dark.png` against `screenshots/visual-after/overview-dark.png`.

### Measuring screenshot flakiness

`PW_FREEZE_CACHE` turns on frozen captures (`tests/freeze.ts`): a fixed clock and peer keys, with API responses and fonts replayed from that file. A request that isn't in the file fails the test, unless `PW_FREEZE_RECORD=1` lets it fill the cache. `playwright.freeze.config.ts` adds a fixed locale and timezone and turns off retries. `measure-flake.mjs` then compares the runs using the comparator behind `toHaveScreenshot`:

```bash
cd devtools/playwright-visual
export PW_FREEZE_CACHE=$PWD/screenshots/freeze-cache.json
PW_FREEZE_RECORD=1 PW_VISUAL_SUBDIR=run-1 npx playwright test smoke-visual.spec --config playwright.freeze.config.ts
PW_VISUAL_SUBDIR=run-2 npx playwright test smoke-visual.spec --config playwright.freeze.config.ts
node measure-flake.mjs --threshold=0.02 screenshots/run-1 screenshots/run-2
```

Run all captures in the `mcr.microsoft.com/playwright` image matching the locked Playwright version, on the same port: the cache is keyed by full URL, and runners without that image's fonts render differently. Set `PW_FREEZE_CSS` to add a deliberate regression and see whether a threshold catches it.

## Accessibility (`make a11y`)

Runs axe-core against WCAG 2.0/2.1 A and AA on all 11 routes in both schemes, at desktop size and again at 375×812.

- **Fails** on `critical` and `serious` violations.
- **Logs** `moderate` / `minor` findings to the console without failing, so advisory rules stay visible but do not block.

Failure output lists the rule, the offending selectors, and a trimmed HTML snippet for each.

## CI

[`.github/workflows/ui-tests.yml`](../../.github/workflows/ui-tests.yml) runs `make a11y` and `make ui-behavior` on pull requests and on `main`, each on its own runner with a fresh mock stack. When a suite fails, the HTML report and traces are kept as the `playwright-a11y` or `playwright-ui-behavior` artifact for 14 days. Open a trace with `npx playwright show-trace <trace.zip>`.

The same workflow runs `make visual-check` as the `visual baseline` job. It isn't a required check yet: ENG-148 decided it stays non-required for one cycle. When it fails, the actual, expected and diff images are kept with the report and traces as the `playwright-visual-baseline` artifact for 14 days, so a failure can be reviewed without re-running it.

Plain `make playwright-visual` doesn't run in CI, because it uses unfrozen captures and compares nothing.

## Content-Security-Policy

Specs import `test` from `tests/fixtures.ts`, not from `@playwright/test`. It fails a test on any CSP violation in the browser console, so new specs should do the same. `csp.spec` checks the policy itself.

## Troubleshooting

If **`docker compose`** shows an empty **`web/`** mount inside **evuproxy-ui** (HTTP 403 / blank pages), restart **evuproxy-ui** so the bind-mount picks up host files again.

If Playwright reports a missing browser executable, check that `PLAYWRIGHT_BROWSERS_PATH` points at a populated cache (default `~/.cache/ms-playwright`).

```bash
cd devtools/playwright-visual
PWTRACE=1 npx playwright test smoke-visual --headed
```

Failures also write an HTML report to `playwright-report/` (`npx playwright show-report`).

See also [`docs/web-ui.md`](../../docs/web-ui.md).
