/**
 * axe-core accessibility gate for the admin UI.
 *
 * Fails on critical/serious violations only — moderate/minor findings are reported
 * in the console so regressions stay visible without blocking on advisory rules.
 * Runs in both colour schemes because contrast results differ between them.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "./fixtures";
import type { Result } from "axe-core";

import { ROUTES, SCHEMES, gotoRoute, largeConfig, seed } from "./helpers";

const BLOCKING = new Set(["critical", "serious"]);

function format(violations: Result[]): string {
  return violations
    .map((v) => {
      const targets = v.nodes
        .slice(0, 5)
        .map((n) => {
          // The summary carries the numbers needed to act on a finding, e.g. the
          // measured contrast ratio and the two colours axe compared.
          const why = (n.failureSummary || "")
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("Fix"))
            .join("; ");
          return [
            `      ${n.target.join(" ")}`,
            `        ${n.html.replace(/\s+/g, " ").slice(0, 160)}`,
            why ? `        ${why}` : "",
          ]
            .filter(Boolean)
            .join("\n");
        })
        .join("\n");
      const more = v.nodes.length > 5 ? `\n      … ${v.nodes.length - 5} more` : "";
      return `  [${v.impact}] ${v.id}: ${v.help}\n${targets}${more}\n      ${v.helpUrl}`;
    })
    .join("\n\n");
}

async function expectNoBlockingViolations(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();

  const blocking = results.violations.filter((v) => BLOCKING.has(v.impact || ""));
  const advisory = results.violations.filter((v) => !BLOCKING.has(v.impact || ""));

  if (advisory.length > 0) {
    console.log(`\nadvisory findings — ${label}:\n${format(advisory)}\n`);
  }

  // Assert on rule ids so a failure prints a short diff; the detail is in the message.
  const ids = blocking.map((v) => `${v.id} (${v.nodes.length})`);
  expect(ids, `blocking a11y violations on ${label}:\n${format(blocking)}`).toEqual([]);
}

test.describe("accessibility on a phone (axe-core)", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`a11y phone ${route} ${scheme}`, async ({ page, baseURL }) => {
        test.skip(!baseURL, "baseURL unset");
        await seed(page, { scheme });
        await gotoRoute(page, baseURL!, route);
        await expectNoBlockingViolations(page, `phone ${route} (${scheme})`);
      });
    }
  }
});

test.describe("accessibility (axe-core)", () => {
  for (const scheme of SCHEMES) {
    for (const route of ROUTES) {
      test(`a11y ${route} ${scheme}`, async ({ page, baseURL }) => {
        test.skip(!baseURL, "baseURL unset");
        await seed(page, { scheme });
        await gotoRoute(page, baseURL!, route);
        await expectNoBlockingViolations(page, `${route} (${scheme})`);
      });
    }

    test(`a11y not connected ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await page.addInitScript((s) => localStorage.setItem("evu-color-scheme", s), scheme);
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(baseURL! + "/#/overview");
      await page.locator("#token-not-connected").waitFor({ state: "visible" });
      await page.waitForLoadState("networkidle").catch(() => undefined);
      await expectNoBlockingViolations(page, `not connected (${scheme})`);
    });

    test(`a11y connection lost ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await gotoRoute(page, baseURL!, "routes");
      // A 401 shows the banner's every control, and stale rows are behind it.
      await page.route("**/api/**", (route) => route.fulfill({ status: 401, json: { error: "unauthorized" } }));
      await page.locator("#routes-refresh").click();
      await page.locator("#connection-banner-token").waitFor({ state: "visible" });
      await page.locator(".page:not([hidden]) .stale-tag").waitFor({ state: "visible" });
      await expectNoBlockingViolations(page, `connection lost (${scheme})`);
    });

    test(`a11y first-run checklist ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await page.route("**/api/v1/config", async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), peers: [] } });
      });
      await gotoRoute(page, baseURL!, "overview");
      await page.locator(".overview-first-run").waitFor({ state: "visible" });
      await expectNoBlockingViolations(page, `first-run checklist (${scheme})`);
    });

    for (const route of ["routes", "peers", "inbound", "topology"] as const) {
      test(`a11y large config ${route} ${scheme}`, async ({ page, baseURL }) => {
        test.skip(!baseURL, "baseURL unset");
        await seed(page, { scheme });
        await page.route("**/api/v1/config", async (r) => {
          if (r.request().method() !== "GET") return r.continue();
          const res = await r.fetch();
          await r.fulfill({ response: res, json: largeConfig(await res.json()) });
        });
        await gotoRoute(page, baseURL!, route);
        await page.locator(`#page-${route} .table-sort, #page-${route} [data-topo-toggle]`).first().waitFor({ state: "visible" });
        await expectNoBlockingViolations(page, `large config ${route} (${scheme})`);
      });
    }

    test(`a11y danger confirm ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await page.route("**/api/v1/pending", async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), pending: true, discard_available: true, discard_change_count: 3 } });
      });
      await gotoRoute(page, baseURL!, "pending");
      // By keyboard, so no enter transition is mid-fade when axe measures contrast.
      await page.locator("#pending-discard").focus();
      await page.keyboard.press("Enter");
      await page.locator("#confirm-modal").waitFor({ state: "visible" });
      await expectNoBlockingViolations(page, `danger confirm (${scheme})`);
    });

    test(`a11y pending changes list ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await page.route("**/api/v1/pending", async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        // An applied config with no rows, so whatever is saved lists as added.
        const applied = { ...body.applied_config, peers: [], input_allows: [] };
        await route.fulfill({ response: res, json: { ...body, pending: true, applied_config: applied } });
      });
      await gotoRoute(page, baseURL!, "pending");
      await page.locator("#pending-changes-list .pending-change").first().waitFor({ state: "visible" });
      await page.locator("#pending-raw-diff summary").click();
      await page.locator("#pending-mode-unified").waitFor({ state: "visible" });
      await expectNoBlockingViolations(page, `pending changes list (${scheme})`);
    });

    test(`a11y apply bar and result ${scheme}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      await seed(page, { scheme });
      await page.route("**/api/v1/pending", async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), pending: true } });
      });
      await page.route("**/api/v1/validate", (route) =>
        route.fulfill({
          json: {
            ok: false,
            errors: [{ code: "nft_syntax", message: "nft -c rejected the ruleset." }],
            warnings: [{ code: "lockout_risk_source_allow", message: "Your IP is not in the source allowlist." }],
            detected_client_ip: "203.0.113.50",
            ip_detection_source: "direct",
          },
        })
      );
      await gotoRoute(page, baseURL!, "routes");
      await page.locator("#apply-bar-apply").click();
      await page.locator("#pending-validate-panel").waitFor({ state: "visible" });
      await page.locator("#pending-lockout-ack").waitFor({ state: "visible" });
      await expectNoBlockingViolations(page, `apply bar and failed result (${scheme})`);
    });
  }
});
