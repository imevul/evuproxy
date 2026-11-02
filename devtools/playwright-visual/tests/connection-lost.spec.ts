/**
 * An API outage has to say what's wrong, leave what was loaded on screen, and end by
 * itself. The API is stopped with route interception, and restored by removing the route.
 */
import { expect, test, type Page, type Route as PwRoute } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const BAD_GATEWAY = "<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>";

type Outage = "network" | "502" | "401";

/** Stops the API until the returned function is called. */
async function stopApi(page: Page, how: Outage): Promise<() => Promise<void>> {
  const handler = (route: PwRoute): Promise<void> => {
    if (how === "network") return route.abort();
    if (how === "502") return route.fulfill({ status: 502, contentType: "text/html", body: BAD_GATEWAY });
    return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' });
  };
  await page.route("**/api/**", handler);
  return () => page.unroute("**/api/**", handler);
}

const banner = (page: Page) => page.locator("#connection-banner");
const staleTag = (page: Page) => page.locator(".page:not([hidden]) .stale-tag");
const disabledLinks = (page: Page) => page.locator(".nav-link.nav-disabled");
const navLink = (page: Page, route: string) => page.locator(`.nav-link[data-route="${route}"]`);

/** The API is back: no banner, no marker, every link usable, and no reload needed for it. */
async function expectRecovered(page: Page): Promise<void> {
  await expect(banner(page)).toBeHidden({ timeout: 10_000 });
  await expect(staleTag(page)).toHaveCount(0);
  await expect(disabledLinks(page)).toHaveCount(0);
  await expect(page.locator("#api-status")).toHaveText("API OK");
}

async function markThisPageLoad(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __sameLoad: boolean }).__sameLoad = true;
  });
}

async function expectNoReload(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as unknown as { __sameLoad?: boolean }).__sameLoad)).toBe(true);
}

test.beforeEach(async ({ page }) => {
  await seed(page, { scheme: "light" });
});

test("an outage nobody acted on shows the banner and stale data, then recovers by itself", async ({ page }) => {
  test.setTimeout(120_000);
  await page.route("**/api/v1/events*", (route) =>
    route.fulfill({ json: { events: [{ ts: "2026-11-01T10:00:00Z", event: "reload_ok" }] } })
  );
  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#overview-events-list li")).toHaveCount(1);
  await expect(banner(page)).toBeHidden();
  await markThisPageLoad(page);
  const cards = await page.locator("#overview-cards .evu-card").count();
  expect(cards).toBeGreaterThan(0);

  const restore = await stopApi(page, "network");
  // No click: the page's own polling is what notices. Waits for the events poll to fail as well.
  const eventsPollFailed = page.waitForRequest("**/api/v1/events*", { timeout: 35_000 });
  await expect(banner(page)).toBeVisible({ timeout: 45_000 });
  await eventsPollFailed;

  await expect(banner(page)).toContainText("Can't reach the EvuProxy API");
  await expect(banner(page)).toContainText("may be out of date");
  await expect(page.locator("#connection-banner-retry")).toBeVisible();
  await expect(page.locator("#connection-banner-token")).toBeHidden();
  await expect(staleTag(page)).toHaveText("Stale data");
  await expect(page.locator("#api-status")).toHaveText("API error");

  // What was loaded is still there, and nothing claims to be empty.
  await expect(page.locator("#overview-cards .evu-card")).toHaveCount(cards);
  await expect(page.locator("#overview-actions-card")).toBeVisible();
  await expect(page.locator("#overview-events-list li")).toHaveCount(1);
  await expect(page.locator("#overview-events-empty")).toBeHidden();
  await expect(disabledLinks(page)).toHaveCount(9);

  await restore();
  await expectRecovered(page);
  await expect(page.locator("#toaster")).toContainText("Connection restored");
  await expectNoReload(page);
  await navLink(page, "routes").click();
  await expect(page.locator("#page-routes")).toBeVisible();
  await expect(page.locator("#routes-table-wrap table.data")).toBeVisible();
});

test("a gateway error says the API is unreachable and keeps the page's rows", async ({ page }) => {
  await gotoRoute(page, origin, "routes");
  const table = page.locator("#routes-table-wrap table.data");
  await expect(table).toBeVisible();
  await markThisPageLoad(page);

  const restore = await stopApi(page, "502");
  await page.locator("#routes-refresh").click();
  await expect(banner(page)).toContainText("Can't reach the EvuProxy API");
  await expect(banner(page)).toContainText("HTTP 502");
  await expect(page.locator("#connection-banner-token")).toBeHidden();
  await expect(staleTag(page)).toBeVisible();
  await expect(table).toBeVisible();
  await expect(page.locator("#page-routes")).toBeVisible();

  await restore();
  await expectRecovered(page);
  await expectNoReload(page);
  await expect(table).toBeVisible();
  await expect(page.locator("#page-routes")).toBeVisible();
});

test("a 401 says the token is the problem, and points at where to fix it", async ({ page }) => {
  await gotoRoute(page, origin, "routes");
  await expect(page.locator("#routes-table-wrap table.data")).toBeVisible();

  const restore = await stopApi(page, "401");
  await page.locator("#routes-refresh").click();
  await expect(banner(page)).toContainText("rejected this browser's token");
  await expect(banner(page)).toContainText("wrong or missing");
  await expect(banner(page)).not.toContainText("Can't reach");
  await expect(page.locator("#routes-table-wrap table.data")).toBeVisible();

  const tokenLink = page.locator("#connection-banner-token");
  await expect(tokenLink).toBeVisible();
  await expect(navLink(page, "token")).not.toHaveClass(/nav-disabled/);
  await tokenLink.click();
  await expect(page.locator("#page-token")).toBeVisible();
  await expect(banner(page)).toBeVisible();

  await restore();
  await expectRecovered(page);
});

test("the banner changes when the cause does", async ({ page }) => {
  await gotoRoute(page, origin, "routes");
  const restoreNetwork = await stopApi(page, "network");
  await page.locator("#routes-refresh").click();
  await expect(banner(page)).toContainText("Can't reach the EvuProxy API");
  await restoreNetwork();
  const restore401 = await stopApi(page, "401");
  await expect(banner(page)).toContainText("rejected this browser's token", { timeout: 10_000 });
  await restore401();
  await expectRecovered(page);
});

test("Retry reports a failure, and recovers at once when the API is back", async ({ page }) => {
  await gotoRoute(page, origin, "routes");
  const restore = await stopApi(page, "network");
  await page.locator("#routes-refresh").click();
  await expect(banner(page)).toBeVisible();

  const retry = page.locator("#connection-banner-retry");
  await retry.click();
  await expect(page.locator("#connection-banner-note")).toContainText("Still no answer");
  await expect(banner(page)).toBeVisible();

  await restore();
  await retry.focus();
  await page.keyboard.press("Enter");
  await expectRecovered(page);
  await expect(page.locator("#main-content")).toBeFocused();
});

test("one broken endpoint gets no banner, and doesn't read as empty", async ({ page }) => {
  await page.route("**/api/v1/events*", (route) => route.abort());
  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#overview-cards")).toContainText("Recent apply and geo events could not be loaded.");
  await expect(page.locator("#overview-cards")).not.toContainText("No recent apply or geo events");
  await expect(page.locator("#overview-events-empty")).toBeHidden();
  await expect(banner(page)).toBeHidden();
  await expect(disabledLinks(page)).toHaveCount(0);
});

test("the API's own errors are not an outage", async ({ page }) => {
  await gotoRoute(page, origin, "routes");
  const table = page.locator("#routes-table-wrap table.data");
  await expect(table).toBeVisible();
  await page.route("**/api/v1/config", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"another operation is in progress"}' })
  );
  await page.locator("#routes-refresh").click();
  await expect(page.locator("#routes-msg")).toContainText("another operation is in progress");
  await expect(table).toBeVisible();
  await expect(banner(page)).toBeHidden();
  await expect(disabledLinks(page)).toHaveCount(0);
});

test("opening the UI during an outage says nothing has loaded, then fills in", async ({ page }) => {
  await page.goto(`${origin}/`, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  const restore = await stopApi(page, "network");
  await page.reload({ waitUntil: "domcontentloaded" });

  await expect(banner(page)).toBeVisible();
  await expect(page.locator("#overview-cards")).toContainText("Nothing has loaded yet");
  await expect(page.locator("#overview-events-empty")).toBeHidden();
  await expect(page.locator("#overview-events-card")).toBeHidden();
  await expect(page.locator("#connection-banner-stale")).not.toContainText("out of date");
  await expect(staleTag(page)).toHaveCount(0);
  await markThisPageLoad(page);

  await restore();
  await expectRecovered(page);
  await expectNoReload(page);
  await expect(page.locator("#overview-cards")).not.toContainText("Nothing has loaded yet");
  await expect(page.locator("#overview-cards .overview-dash-host")).toBeVisible();
  await expect(page.locator("#overview-events-card")).toBeVisible();
});

test("a route opened during an outage stays put and loads on recovery", async ({ page }) => {
  await gotoRoute(page, origin, "overview");
  const restore = await stopApi(page, "network");
  await page.evaluate(() => {
    location.hash = "#/inbound";
  });
  await expect(banner(page)).toBeVisible();
  await expect(page.locator("#page-inbound")).toBeVisible();
  await expect(page.locator("#inbound-table-wrap .evu-empty")).toHaveCount(0);

  await restore();
  await expectRecovered(page);
  await expect(page.locator("#page-inbound")).toBeVisible();
  await expect(page.locator("#inbound-table-wrap table.data")).toBeVisible();
});

for (const { route, refresh, region } of [
  { route: "peers", refresh: "#peers-refresh", region: "#peers-table-wrap" },
  { route: "routes", refresh: "#routes-refresh", region: "#routes-table-wrap" },
  { route: "inbound", refresh: "#inbound-refresh", region: "#inbound-table-wrap" },
  { route: "stats", refresh: "#stats-refresh", region: "#stats-wg-wrap" },
  { route: "logs", refresh: "#logs-refresh", region: "#logs-view" },
  { route: "pending", refresh: "#pending-refresh", region: "#pending-status-alert" },
] as const) {
  test(`a failed refresh leaves ${route} as it was`, async ({ page }) => {
    await gotoRoute(page, origin, route);
    const before = ((await page.locator(region).textContent()) || "").replace(/\s+/g, " ").trim();
    expect(before).not.toBe("");
    const emptyStates = await page.locator(region).locator(".evu-empty").count();

    const restore = await stopApi(page, "network");
    await page.locator(refresh).click();
    await expect(banner(page)).toBeVisible();
    await expect(page.locator(region)).not.toHaveAttribute("aria-busy", "true");
    // The opening text stands for the rest: a page that cleared itself would lose it too.
    await expect(page.locator(region)).toContainText(before.slice(0, 40));
    await expect(page.locator(region).locator(".evu-empty")).toHaveCount(emptyStates);

    await restore();
    await expectRecovered(page);
  });
}

test("recovery leaves unsaved edits alone", async ({ page }) => {
  test.setTimeout(90_000);
  await gotoRoute(page, origin, "settings");
  const endpoint = page.locator("#settings-wg-endpoint");
  await endpoint.fill("edited.example:51820");
  await expect(page.locator(".page:not([hidden]) .save-bar")).toBeVisible();

  const restore = await stopApi(page, "network");
  await expect(banner(page)).toBeVisible({ timeout: 45_000 });
  await expect(endpoint).toHaveValue("edited.example:51820");

  await restore();
  await expectRecovered(page);
  await expect(endpoint).toHaveValue("edited.example:51820");
  await expect(page.locator(".page:not([hidden]) .save-bar")).toBeVisible();
});

test("recovery keeps the tab the operator was on", async ({ page }) => {
  test.setTimeout(90_000);
  await gotoRoute(page, origin, "settings");
  await page.locator("#settings-tab-maint-btn").click();
  await expect(page.locator("#settings-tab-maint-panel")).toBeVisible();

  const restore = await stopApi(page, "network");
  await expect(banner(page)).toBeVisible({ timeout: 45_000 });
  await restore();
  await expectRecovered(page);
  await expect(page.locator("#settings-tab-maint-panel")).toBeVisible();
  await expect(page.locator("#settings-tab-maint-btn")).toHaveAttribute("aria-selected", "true");
});

test("no token gets the token page, not the banner", async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${origin}/#/overview`);
  await expect(page.locator("#token-not-connected")).toBeVisible();
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await expect(banner(page)).toBeHidden();
  await context.close();
});
