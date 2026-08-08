/**
 * Screenshots primary hash routes and the modal surfaces against the Docker dev UI
 * (docker-compose.dev.yml). Requires mock API reachable; TOKEN must match
 * MOCK_API_TOKEN (default "dev").
 *
 * Every surface is captured in both light and dark: `<name>-light.png` / `<name>-dark.png`.
 */
import { test } from "@playwright/test";

import { ROUTES, SCHEMES, capture, gotoRoute, seed } from "./helpers";

test.describe("routes (full-page screenshots)", () => {
  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`capture ${route} ${scheme}`, async ({ page, baseURL }) => {
        test.skip(!baseURL, "baseURL unset");
        await seed(page, { scheme });
        await gotoRoute(page, baseURL!, route);
        await capture(page, `${route}-${scheme}`);
      });
    }
  }
});

test.describe("modals (full-page screenshots)", () => {
  for (const scheme of SCHEMES) {
    test(`capture peer editor tabs ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "peers");

      await page.locator("#peers-add-start").click();
      await page.locator("#peer-modal").waitFor({ state: "visible" });
      await capture(page, `modal-peer-editor-${scheme}`);

      // Onboarding and install copy live behind the editor's own tabs.
      const tabs = page.locator('#peer-modal [role="tab"]');
      const count = await tabs.count();
      for (let i = 1; i < count; i += 1) {
        const tab = tabs.nth(i);
        if ((await tab.getAttribute("aria-disabled")) === "true") continue;
        const label = (await tab.textContent())?.trim().toLowerCase().replace(/\W+/g, "-") || `tab${i}`;
        await tab.click();
        await capture(page, `modal-peer-editor-${label}-${scheme}`);
      }
    });

    test(`capture route editor advanced ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme, advanced: true });
      await gotoRoute(page, baseURL!, "routes");

      await page.locator("#routes-add").click();
      await page.locator("#route-modal").waitFor({ state: "visible" });
      await capture(page, `modal-route-editor-${scheme}`);

      await page.locator("#route-tab-advanced-btn").click();
      await page.locator("#route-tab-advanced-panel").waitFor({ state: "visible" });
      await capture(page, `modal-route-editor-advanced-${scheme}`);
    });

    test(`capture geo country picker ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "geoblocking");

      await page.locator("#geo-tags-edit").click();
      await page.locator("#geo-country-modal").waitFor({ state: "visible" });
      await capture(page, `modal-geo-countries-${scheme}`);
    });

    test(`capture geo tabs ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme, advanced: true });
      await gotoRoute(page, baseURL!, "geoblocking");

      await page.locator("#geo-tab-advanced-btn").click();
      await page.locator("#geo-tab-advanced-panel").waitFor({ state: "visible" });
      await capture(page, `geoblocking-advanced-${scheme}`);

      await page.locator("#geo-tab-zones-btn").click();
      await page.locator("#geo-tab-zones-panel").waitFor({ state: "visible" });
      await capture(page, `geoblocking-zones-${scheme}`);
    });

    test(`capture context help ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "peers");

      await page.locator("#page-peers .btn-help-trigger").first().click();
      await page.locator("#context-help-modal").waitFor({ state: "visible" });
      await capture(page, `modal-context-help-${scheme}`);
    });

    test(`capture confirm dialog ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "peers");

      // Peer removal is the confirm trigger that is always reachable in the mock;
      // the Pending discard button is disabled whenever there is nothing pending.
      await page.locator("#page-peers [data-peer-del]").first().click();
      await page.locator("#confirm-modal").waitFor({ state: "visible" });
      await capture(page, `modal-confirm-${scheme}`);
    });

    test(`capture shortcuts dialog ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "overview");

      await page.keyboard.press("Shift+Slash");
      await page.locator("#shortcuts-modal").waitFor({ state: "visible" });
      await capture(page, `modal-shortcuts-${scheme}`);
    });

    test(`capture pending lockout gate ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      // Stubbed so the warning state is captured regardless of mock config.
      await page.route("**/api/v1/validate", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            ok: true,
            warnings: [
              {
                code: "lockout_risk_source_allow",
                message:
                  "Your address 203.0.113.50 is not in the source allowlist for route 1; applying will drop this connection.",
              },
            ],
            detected_client_ip: "203.0.113.50",
            ip_detection_source: "direct",
          }),
        })
      );
      await gotoRoute(page, baseURL!, "pending");

      await page.locator("#pending-check-config").click();
      await page.locator("#pending-lockout-ack-wrap").waitFor({ state: "visible" });
      await capture(page, `pending-lockout-gate-${scheme}`);
    });
  }
});
