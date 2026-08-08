/**
 * Structural accessibility that axe cannot judge: whether the skip link works,
 * whether tables name their columns, and whether a failed validation actually
 * points at the field that failed.
 */
import { expect, test } from "@playwright/test";

import { ROUTES, gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

test.describe("landmarks and headings", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("the skip link moves focus past the navigation", async ({ page }) => {
    await gotoRoute(page, origin, "overview");
    await page.keyboard.press("Tab");

    const skip = page.locator(".skip-link");
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();

    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main-content");
  });

  test("every route has exactly one visible h1", async ({ page }) => {
    for (const route of ROUTES) {
      await gotoRoute(page, origin, route);
      const visible = await page
        .locator("h1")
        .evaluateAll((els) => els.filter((el) => (el as HTMLElement).offsetParent !== null).length);
      expect(visible, `visible <h1> count on ${route}`).toBe(1);
    }
  });
});

test.describe("tables", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  // Routes whose tables are populated by the mock API.
  for (const route of ["peers", "routes", "inbound", "stats", "logs"] as const) {
    test(`${route} column headers are scoped and named`, async ({ page }) => {
      await gotoRoute(page, origin, route);
      const headers = page.locator(`#page-${route} table.data th`);
      expect(await headers.count()).toBeGreaterThan(0);

      const bad = await headers.evaluateAll((els) =>
        els
          .filter((el) => el.getAttribute("scope") !== "col" || !el.textContent?.trim())
          .map((el) => el.outerHTML.slice(0, 80))
      );
      expect(bad, `unscoped or unnamed headers in ${route}`).toEqual([]);
    });
  }
});

test.describe("validation", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("a failed save marks the field and describes it with the message", async ({ page }) => {
    await gotoRoute(page, origin, "inbound");
    await page.locator("#inbound-add").click();
    await expect(page.locator("#inbound-modal")).not.toHaveClass(/is-hidden/);

    // Enabled with no destination port is the documented failure case.
    await page.locator("#inbound-f-dport").fill("");
    await page.locator("#inbound-save").click();

    const dport = page.locator("#inbound-f-dport");
    await expect(dport).toHaveAttribute("aria-invalid", "true");
    await expect(dport).toHaveAttribute("aria-describedby", /inbound-msg/);
    await expect(dport).toBeFocused();
    await expect(page.locator("#inbound-msg")).toHaveText(/Destination port is required/);
  });
});

test.describe("focus after a re-render", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  // The button lives inside the table it replaces, so activating it destroys the
  // element focus was on. Falling back to <body> restarts a keyboard user at the
  // top of the document.
  test("clearing the filters from the logs empty state keeps focus in the toolbar", async ({
    page,
  }) => {
    await gotoRoute(page, origin, "logs");
    await page.locator("#logs-search").fill("zzz-no-such-log-line-zzz");

    const emptyClear = page.locator("#logs-empty-clear");
    await expect(emptyClear).toBeVisible();
    await emptyClear.click();

    await expect(page.locator("#logs-filter-clear")).toBeFocused();
  });
});
