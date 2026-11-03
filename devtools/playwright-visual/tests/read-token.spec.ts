/**
 * A read token sees Overview, Stats and Logs and nothing that can change the host. These
 * run against the mock, which refuses the same routes as the server. `dev-read` is its
 * default read token.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";
const READ_TOKEN = process.env.MOCK_API_READ_TOKEN?.trim() || "dev-read";

async function seedReadToken(page: Page) {
  await seed(page, { scheme: "light" });
  await page.addInitScript((tok: string) => localStorage.setItem("evuproxy_api_token", tok), READ_TOKEN);
}

test.describe("read token", () => {
  test("says so, and disables what would change the host", async ({ page }) => {
    await seedReadToken(page);
    await gotoRoute(page, origin, "overview");
    await expect(page.locator("#read-only-notice")).toBeVisible();
    await expect(page.locator("#btn-geo")).toBeDisabled();
    await expect(page.locator("#overview-maintenance-toggle")).toBeDisabled();
    for (const id of ["apply-bar-apply", "pending-apply", "btn-restore-run", "btn-backup-run", "peer-save", "route-save", "inbound-save", "config-upload-apply"]) {
      await expect(page.locator("#" + id)).toBeDisabled();
    }
    await expect(page.locator("#apply-bar")).toBeHidden();
    // A 403 on the session poll isn't an API that stopped answering.
    await expect(page.locator("#apply-session")).toBeHidden();
    await expect(page.locator("#connection-banner")).toBeHidden();
  });

  test("offers only the pages it can open", async ({ page }) => {
    await seedReadToken(page);
    await gotoRoute(page, origin, "overview");
    await expect(page.locator("#read-only-notice")).toBeVisible();
    for (const route of ["overview", "stats", "logs", "token"]) {
      await expect(page.locator(`.nav-link[data-route="${route}"]`)).not.toHaveClass(/nav-disabled/);
    }
    for (const route of ["peers", "routes", "topology", "inbound", "geoblocking", "pending", "settings"]) {
      await expect(page.locator(`.nav-link[data-route="${route}"]`)).toHaveClass(/nav-disabled/);
    }
  });

  test("a link to a page it can't open lands on Overview", async ({ page }) => {
    await seedReadToken(page);
    await page.goto(origin + "/#/peers");
    await expect(page.locator("#page-overview")).toBeVisible();
    await expect(page.locator("#page-peers")).toBeHidden();
    await expect(page).toHaveURL(/#\/overview/);
  });

  test("Stats and Logs load", async ({ page }) => {
    await seedReadToken(page);
    await gotoRoute(page, origin, "stats");
    await expect(page.locator("#page-stats")).toBeVisible();
    await expect(page.locator("#stats-msg")).toHaveText("");
    await expect(page.locator("#stats-wg-wrap table")).toBeVisible();
    await gotoRoute(page, origin, "logs");
    await expect(page.locator("#page-logs")).toBeVisible();
    await expect(page.locator("#logs-table-wrap tbody tr").first()).toBeVisible();
    // Adding a source to the break-glass list is a config write.
    await expect(page.locator("[data-logs-breakglass]")).toHaveCount(0);
  });

  test("the mock refuses it as the server does", async ({ page, request }) => {
    await seedReadToken(page);
    await gotoRoute(page, origin, "overview");
    const headers = { "X-API-Token": READ_TOKEN };
    expect((await request.get(origin + "/api/v1/overview", { headers })).status()).toBe(200);
    expect((await request.get(origin + "/api/v1/config", { headers })).status()).toBe(403);
    expect((await request.post(origin + "/api/v1/reload", { headers })).status()).toBe(403);
    expect((await request.get(origin + "/api/v1/overview", { headers: { "X-API-Token": "wrong" } })).status()).toBe(401);
  });
});

test.describe("changing token", () => {
  test("Connect reports the scope and the write token gets everything back", async ({ page }) => {
    await seedReadToken(page);
    await gotoRoute(page, origin, "token");
    await page.locator("#token").fill(READ_TOKEN);
    await page.locator("#token-connect").click();
    await expect(page.locator("#auth-msg")).toContainText("read-only");

    await page.locator("#token").fill(token());
    await page.locator("#token-connect").click();
    await expect(page.locator("#auth-msg")).toHaveText("Connected. The token is saved in this browser.");
    await expect(page.locator("#read-only-notice")).toBeHidden();
    await expect(page.locator('.nav-link[data-route="peers"]')).not.toHaveClass(/nav-disabled/);
    await expect(page.locator("#btn-geo")).toBeEnabled();
  });

  test("the write token sees no notice", async ({ page }) => {
    await seed(page, { scheme: "light" });
    await gotoRoute(page, origin, "overview");
    await expect(page.locator("#btn-geo")).toBeEnabled();
    await expect(page.locator("#read-only-notice")).toBeHidden();
    await expect(page.locator('.nav-link[data-route="settings"]')).not.toHaveClass(/nav-disabled/);
  });
});
