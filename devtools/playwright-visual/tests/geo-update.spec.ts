/**
 * Update geo lists, from both places it can be run. With confirm on, the host refreshes
 * the last applied config's sets and says when it left unapplied geo changes out, and the
 * page has to pass that on. /update-geo is stubbed: the host side is covered by Go tests
 * and devtools/rollback-vm.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed, type Route } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const toast = (page: Page) => page.locator("#toaster .evu-toast");

const PLACES: { route: Route; button: string; msg: string }[] = [
  { route: "overview", button: "#btn-geo", msg: "#overview-action-msg" },
  { route: "geoblocking", button: "#geo-update-lists", msg: "#geo-msg" },
];

for (const { route, button, msg } of PLACES) {
  test.describe(`Update geo lists on ${route}`, () => {
    test.beforeEach(async ({ page }) => {
      await seed(page, { scheme: "light" });
    });

    async function clickWith(page: Page, status: number, json: Record<string, unknown>) {
      await page.route("**/api/v1/update-geo", (r) => r.fulfill({ status, json }));
      await gotoRoute(page, origin, route);
      await page.locator(button).click();
    }

    test("says plainly when nothing was held back", async ({ page }) => {
      await clickWith(page, 200, { result: "geo_updated", geo_changes_held_back: false });
      await expect(toast(page)).toContainText("Geo lists updated on host");
    });

    test("says when unapplied geo changes wait for Apply", async ({ page }) => {
      await clickWith(page, 200, { result: "geo_updated", geo_changes_held_back: true });
      await expect(toast(page)).toContainText("Your unapplied geo changes go live when you Apply.");
    });

    test("shows the refusal during a confirm window", async ({ page }) => {
      await clickWith(page, 409, {
        error: "an Apply is waiting for confirmation: run `evuproxy reload-confirm` or `evuproxy reload-revert` first",
        error_code: "apply_session_active",
      });
      await expect(page.locator(msg)).toContainText("an Apply is waiting for confirmation");
      await expect(toast(page)).toHaveCount(0);
    });
  });
}
