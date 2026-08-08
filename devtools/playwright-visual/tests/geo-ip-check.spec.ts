/**
 * Geoblock "Check an IP" panel — dry-run against form rules.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

test.describe("geo IP check", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("reports allowed vs blocked for sample addresses", async ({ page }) => {
    await gotoRoute(page, origin, "geoblocking");

    const input = page.locator("#geo-ip-check-input");
    const result = page.locator("#geo-ip-check-result");
    await input.fill("203.0.113.9");
    await page.locator("#geo-ip-check-run").click();
    await expect(result).toBeVisible();
    await expect(result).toHaveClass(/evu-alert--success/);
    await expect(page.locator("#geo-ip-check-summary")).toContainText(/allowed/i);

    await input.fill("8.8.8.8");
    await page.locator("#geo-ip-check-run").click();
    await expect(result).toHaveClass(/evu-alert--danger/);
    await expect(page.locator("#geo-ip-check-summary")).toContainText(/blocked/i);
  });

  test("Use my IP fills the field and runs the check", async ({ page }) => {
    await gotoRoute(page, origin, "geoblocking");
    await page.locator("#geo-ip-check-mine").click();
    await expect(page.locator("#geo-ip-check-input")).toHaveValue("203.0.113.50");
    await expect(page.locator("#geo-ip-check-result")).toBeVisible();
  });
});
