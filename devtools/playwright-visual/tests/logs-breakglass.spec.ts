/**
 * Geoblock SRC cells offer a break-glass add control when the IP is not covered.
 */
import { expect, test } from "./fixtures";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

async function clearBreakGlass(request: import("@playwright/test").APIRequestContext) {
  const get = await request.get(origin + "/api/v1/config", {
    headers: { Authorization: "Bearer " + token() },
  });
  const cfg = await get.json();
  if (!cfg.geo) cfg.geo = {};
  cfg.geo.break_glass_cidrs = [];
  await request.put(origin + "/api/v1/config", {
    headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    data: cfg,
  });
}

test.describe("logs break-glass affordance", () => {
  test.beforeEach(async ({ page, request }) => {
    await clearBreakGlass(request);
    await seed(page, { scheme: "light" });
  });

  test("geoblock SRC without break-glass coverage shows the add button", async ({ page }) => {
    await gotoRoute(page, origin, "logs");
    const btn = page.locator('[data-logs-breakglass="198.51.100.2"]');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-label", /break-glass/i);
  });

  test("adds the /32 at once, and Undo takes it off and returns to the button", async ({ page, request }) => {
    await gotoRoute(page, origin, "logs");
    await page.locator('[data-logs-breakglass="198.51.100.2"]').first().click();
    await expect(page.locator("#confirm-modal")).toBeHidden();
    await expect(page.locator("#toaster")).toContainText(/Added 198\.51\.100\.2\/32/);
    await expect(page.locator('[data-logs-breakglass="198.51.100.2"]')).toHaveCount(0);

    await page.locator("#toaster").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator("#toaster")).toContainText(/Removed 198\.51\.100\.2\/32/);
    await expect(page.locator('[data-logs-breakglass="198.51.100.2"]').first()).toBeFocused();
    const cfg = await (
      await request.get(origin + "/api/v1/config", { headers: { Authorization: "Bearer " + token() } })
    ).json();
    expect(cfg.geo.break_glass_cidrs || []).not.toContain("198.51.100.2/32");
  });

  test("Undo removes only this entry, from fresh config", async ({ page, request }) => {
    await gotoRoute(page, origin, "logs");
    await page.locator('[data-logs-breakglass="198.51.100.2"]').click();
    const undo = page.locator("#toaster").getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();

    // Saved elsewhere after the add: Undo must leave it, which a snapshot restore would not.
    const get = await request.get(origin + "/api/v1/config", {
      headers: { Authorization: "Bearer " + token() },
    });
    const cfg = await get.json();
    cfg.geo.break_glass_cidrs.push("203.0.113.7/32");
    await request.put(origin + "/api/v1/config", {
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      data: cfg,
    });

    await undo.click();
    await expect(page.locator("#toaster")).toContainText(/Removed 198\.51\.100\.2\/32/);
    await expect(page.locator('[data-logs-breakglass="198.51.100.2"]')).toBeVisible();
    const after = await request.get(origin + "/api/v1/config", {
      headers: { Authorization: "Bearer " + token() },
    });
    expect((await after.json()).geo.break_glass_cidrs).toEqual(["203.0.113.7/32"]);
  });

  test("a failed Undo on a page you left shows an error toast", async ({ page }) => {
    await gotoRoute(page, origin, "logs");
    await page.locator('[data-logs-breakglass="198.51.100.2"]').click();
    const undo = page.locator("#toaster").getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();

    await page.locator('.nav-link[data-route="routes"]').click();
    await expect(page.locator("#page-routes")).toBeVisible();
    await page.route("**/api/v1/config", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' })
        : route.fallback()
    );
    await undo.click();

    const toast = page.locator("#toaster .evu-toast");
    await expect(toast).toHaveText(/disk full/);
    await expect(toast).toHaveAttribute("data-error", "");
  });

  test("a /0 break-glass entry covers every SRC", async ({ page, request }) => {
    const get = await request.get(origin + "/api/v1/config", {
      headers: { Authorization: "Bearer " + token() },
    });
    const cfg = await get.json();
    if (!cfg.geo) cfg.geo = {};
    cfg.geo.break_glass_cidrs = ["0.0.0.0/0"];
    await request.put(origin + "/api/v1/config", {
      headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
      data: cfg,
    });

    await gotoRoute(page, origin, "logs");
    await expect(page.locator("[data-logs-breakglass]")).toHaveCount(0);
  });
});
