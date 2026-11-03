/**
 * One vocabulary: Save writes the draft, Apply changes the host, Refresh re-reads
 * (ENG-139). The API and CLI keep `reload`; the UI text does not.
 */
import { expect, test } from "./fixtures";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

test.beforeEach(async ({ page }) => {
  await seed(page, { scheme: "light" });
});

test("the host action is labelled Apply", async ({ page }) => {
  await page.route("**/api/v1/pending", (route) => route.fulfill({ json: { pending: true } }));
  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#apply-bar-apply")).toHaveText("Apply");
  await gotoRoute(page, origin, "pending");
  await expect(page.locator("#apply-bar-apply")).toHaveText("Apply");
  await expect(page.locator("#pending-refresh")).toHaveText("Refresh");
});

test("activity calls an Apply an Apply, whatever the API recorded", async ({ page }) => {
  const ts = new Date().toISOString();
  await page.route("**/api/v1/events*", (route) =>
    route.fulfill({
      json: {
        events: [
          { ts, event: "reload_ok", detail: "reload" },
          { ts, event: "reload_started", detail: "reload" },
        ],
      },
    })
  );
  await gotoRoute(page, origin, "overview");
  const list = page.locator("#overview-events-list");
  await expect(list).toContainText("Applied config");
  await expect(list).toContainText("Apply started");
  await expect(page.locator("#page-overview")).not.toContainText(/reload/i);
});

test("a failed Apply still shows why", async ({ page }) => {
  await page.route("**/api/v1/events*", (route) =>
    route.fulfill({
      json: { events: [{ ts: new Date().toISOString(), event: "reload_failed", detail: "nft: syntax error" }] },
    })
  );
  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#overview-events-list")).toContainText("Apply failed");
  await expect(page.locator("#overview-events-list")).toContainText("nft: syntax error");
});

test("a failed Apply does not repeat the API's reload error", async ({ page }) => {
  await page.route("**/api/v1/pending", (route) => route.fulfill({ json: { pending: true } }));
  await page.route("**/api/v1/validate", (route) =>
    route.fulfill({ json: { ok: true, warnings: [] } })
  );
  await page.route("**/api/v1/reload", (route) =>
    route.fulfill({ status: 500, json: { error: "reload failed" } })
  );
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#apply-msg")).toHaveText("Apply failed");
});

test("another Apply error is shown as sent", async ({ page }) => {
  await page.route("**/api/v1/pending", (route) => route.fulfill({ json: { pending: false } }));
  await page.route("**/api/v1/validate", (route) =>
    route.fulfill({ json: { ok: true, warnings: [] } })
  );
  await page.route("**/api/v1/reload", (route) =>
    route.fulfill({ status: 503, json: { error: "another operation is in progress" } })
  );
  await gotoRoute(page, origin, "pending");
  await page.locator("#pending-apply").click();
  await expect(page.locator("#apply-msg")).toHaveText("another operation is in progress");
});

test("geo freshness calls an Apply an Apply", async ({ page }) => {
  await page.route("**/api/v1/overview", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    await route.fulfill({
      response,
      json: {
        ...json,
        geo_enabled: true,
        geo_last_success_utc: new Date().toISOString(),
        geo_last_success_source: "reload",
      },
    });
  });
  await gotoRoute(page, origin, "overview");
  await expect(page.locator(".overview-geo-fresh-meta")).toHaveText("Source: Apply");
});

test("no page or help text uses the old labels", async ({ page }) => {
  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#overview-events-list li").first()).toBeVisible();
  // Help bodies sit in <template>s, whose content is not part of body.textContent.
  const text = await page.evaluate(() => {
    const templates = [...document.querySelectorAll("template")].map((t) => t.content.textContent);
    return [document.body.textContent, ...templates].join("\n");
  });
  expect(text).not.toMatch(/reload|apply to host|refresh preview/i);
});
