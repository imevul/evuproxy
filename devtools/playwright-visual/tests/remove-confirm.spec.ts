/**
 * Destructive Remove on Routes / Inbound uses the shared confirm modal.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

async function fetchConfig(request: import("@playwright/test").APIRequestContext) {
  const res = await request.get(origin + "/api/v1/config", {
    headers: { Authorization: "Bearer " + token() },
  });
  return res.json();
}

async function putConfig(request: import("@playwright/test").APIRequestContext, cfg: unknown) {
  await request.put(origin + "/api/v1/config", {
    headers: { Authorization: "Bearer " + token(), "Content-Type": "application/json" },
    data: cfg,
  });
}

test.describe("remove confirmations", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("Routes Remove opens confirm and Cancel leaves the row", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const rowsBefore = await page.locator("#routes-table-wrap tbody tr").count();
    expect(rowsBefore).toBeGreaterThan(0);

    await page.locator("#routes-table-wrap [data-route-del]").first().click();
    const dialog = page.locator("#confirm-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Remove route/i);
    await page.locator("#confirm-modal-cancel").click();
    await expect(dialog).toBeHidden();
    await expect(page.locator("#routes-table-wrap tbody tr")).toHaveCount(rowsBefore);
  });

  test("Inbound Remove confirms and deletes the rule", async ({ page, request }) => {
    const snapshot = await fetchConfig(request);
    try {
      await gotoRoute(page, origin, "inbound");
      const rowsBefore = await page.locator("#inbound-table-wrap tbody tr").count();
      expect(rowsBefore).toBeGreaterThan(0);

      await page.locator("#inbound-table-wrap [data-inbound-del]").first().click();
      const dialog = page.locator("#confirm-modal");
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText(/Remove inbound rule/i);
      await page.locator("#confirm-modal-ok").click();
      await expect(dialog).toBeHidden();
      await expect(page.locator("#inbound-table-wrap tbody tr")).toHaveCount(rowsBefore - 1);
      await expect(page.locator("#inbound-msg")).toContainText(/removed/i);
    } finally {
      await putConfig(request, snapshot);
    }
  });
});
