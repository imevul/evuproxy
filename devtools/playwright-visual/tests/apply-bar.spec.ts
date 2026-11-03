/**
 * The unapplied-changes bar, and the one Apply it carries: checks first, shows named
 * steps, and pins the result at the top. The gate itself is in apply-gate.spec.ts.
 */
import { expect, test, type Page } from "./fixtures";

import { ROUTES, gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const CLEAN = { ok: true, warnings: [], detected_client_ip: "203.0.113.50", ip_detection_source: "direct" };
const BROKEN = {
  ok: false,
  errors: [{ code: "nft_syntax", message: "nft -c rejected the ruleset." }],
  warnings: [],
  detected_client_ip: "203.0.113.50",
  ip_detection_source: "direct",
};

/** Answers /pending from `read()`. No applied config, so three ruleset changes are what counts. */
async function stubPending(page: Page, read: () => Record<string, unknown>) {
  await page.route("**/api/v1/pending", (route) =>
    route.fulfill({
      json: {
        applied_config: null,
        nftables_baseline: "a\nkeep\nb\nkeep\nc",
        nftables: "A\nkeep\nB\nkeep\nC",
        ...read(),
      },
    })
  );
}

async function stubValidate(page: Page, body: Record<string, unknown>) {
  await page.route("**/api/v1/validate", (route) => route.fulfill({ json: body }));
}

const bar = (page: Page) => page.locator("#apply-bar");

test.beforeEach(async ({ page }) => {
  await seed(page, { scheme: "light" });
});

test("the bar and the count are on every page while changes wait", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  for (const route of ROUTES) {
    await gotoRoute(page, origin, route);
    await expect(bar(page), route).toBeVisible();
    await expect(bar(page), route).toContainText("3 unapplied changes");
    await expect(page.locator("#apply-bar-apply"), route).toBeVisible();
    await expect(page.locator("#nav-pending-count"), route).toHaveText("3");
  }
});

test("nothing shows when nothing waits", async ({ page }) => {
  await stubPending(page, () => ({ pending: false }));
  await gotoRoute(page, origin, "routes");
  await expect(bar(page)).toBeHidden();
  await expect(page.locator("#nav-pending-count")).toBeHidden();
  await expect(page.locator("#nav-pending-sr")).toHaveText("");
});

test("the count does not look like an error", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await gotoRoute(page, origin, "routes");
  const badge = page.locator("#nav-pending-count");
  await expect(badge).toBeVisible();
  const color = await badge.evaluate((el) => ({
    badge: getComputedStyle(el).color,
    link: getComputedStyle(el.parentElement!).color,
    background: getComputedStyle(el).backgroundColor,
  }));
  expect(color.badge).toBe(color.link);
  expect(color.background).toBe("rgba(0, 0, 0, 0)");
  // The visible number is hidden from assistive tech, so the link says it in words.
  await expect(page.locator("#nav-pending-sr")).toHaveText(" (3 unapplied changes)");
});

test("one change reads in the singular", async ({ page }) => {
  await stubPending(page, () => ({ pending: true, nftables: "a\nkeep\nb\nkeep\nX" , nftables_baseline: "a\nkeep\nb\nkeep\nc" }));
  await gotoRoute(page, origin, "routes");
  await expect(page.locator("#apply-bar-text")).toHaveText("1 unapplied change");
});

test("the count matches the rows on the Changes list", async ({ page }) => {
  await page.route("**/api/v1/pending", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        pending: true,
        applied_config: { ...body.applied_config, peers: [], input_allows: [] },
      },
    });
  });
  await gotoRoute(page, origin, "pending");
  const rows = await page.locator("#pending-changes-list .pending-change").count();
  expect(rows).toBeGreaterThan(1);
  await expect(page.locator("#apply-bar-text")).toHaveText(rows + " unapplied changes");
  await expect(page.locator("#nav-pending-count")).toHaveText(String(rows));
});

test("the bar stays on screen while the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 400 });
  await stubPending(page, () => ({ pending: true }));
  await gotoRoute(page, origin, "settings");
  await page.evaluate(() => window.scrollTo(0, 200));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  // Pinned to the top edge, not merely still partly on screen.
  expect((await bar(page).boundingBox())!.y).toBe(0);
  await expect(page.locator("#apply-bar-apply")).toBeInViewport({ ratio: 1 });
});

test("a focused field is not left underneath the bar", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 400 });
  await stubPending(page, () => ({ pending: true }));
  await gotoRoute(page, origin, "settings");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const field = page.locator("#page-settings .btn-help-trigger").first();
  await field.focus();
  const barBox = (await bar(page).boundingBox())!;
  expect((await field.boundingBox())!.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
});

test("no page's content is cut off at the main column's edge", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 700 });
  for (const route of ROUTES) {
    await gotoRoute(page, origin, route);
    const over = await page.locator("#main-content").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(over, route).toBeLessThanOrEqual(0);
  }
});

test("Review goes to Pending changes, where it is not offered again", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await gotoRoute(page, origin, "routes");
  await page.locator("#apply-bar-review").click();
  await expect(page.locator("#page-pending")).toBeVisible();
  await expect(page.locator("#apply-bar-review")).toBeHidden();
  await expect(bar(page)).toBeVisible();
});

test("there is one Apply to press at a time", async ({ page }) => {
  let pending = true;
  await stubPending(page, () => ({ pending }));
  await gotoRoute(page, origin, "pending");
  await expect(page.locator("#apply-bar-apply")).toBeVisible();
  await expect(page.locator("#pending-apply")).toBeHidden();
  await expect(page.locator("#pending-check-config")).toBeVisible();

  pending = false;
  await page.reload();
  await expect(bar(page)).toBeHidden();
  await expect(page.locator("#pending-apply")).toBeVisible();

  await gotoRoute(page, origin, "overview");
  await expect(page.locator("#btn-apply")).toHaveCount(0);
});

for (const route of ["overview", "routes", "pending"] as const) {
  test(`Apply clears the bar on ${route}`, async ({ page }) => {
    let pending = true;
    await stubPending(page, () => ({ pending }));
    await stubValidate(page, CLEAN);
    await page.route("**/api/v1/reload", (r) => {
      pending = false;
      return r.fulfill({ json: { result: "reloaded" } });
    });
    await gotoRoute(page, origin, route);
    await page.locator("#apply-bar-apply").click();
    await expect(bar(page)).toBeHidden();
    await expect(page.locator("#nav-pending-count")).toBeHidden();
    await expect(page.locator("#toaster .evu-toast")).toContainText("Applied to host");
    await expect(page.locator("#apply-progress [data-apply-step='done']")).toHaveClass(/is-done/);
    // The button went with the bar, and focus must not fall to <body>.
    await expect(page.locator("#main-content")).toBeFocused();
  });
}

test("Apply names each step as it reaches it", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  let step = "";
  await page.route("**/api/v1/reload/progress", (r) => r.fulfill({ json: { step } }));
  let finishReload = () => {};
  const reloadHeld = new Promise<void>((resolve) => (finishReload = resolve));
  await page.route("**/api/v1/reload", async (r) => {
    await reloadHeld;
    await r.fulfill({ json: { result: "reloaded" } });
  });
  let finishCheck = () => {};
  const checkHeld = new Promise<void>((resolve) => (finishCheck = resolve));
  await page.route("**/api/v1/validate", async (r) => {
    await checkHeld;
    await r.fulfill({ json: CLEAN });
  });
  await gotoRoute(page, origin, "routes");

  const item = (name: string) => page.locator(`#apply-progress [data-apply-step='${name}']`);
  await page.locator("#apply-bar-apply").click();
  await expect(item("validate")).toHaveAttribute("aria-current", "step");
  await expect(item("validate")).toHaveText("Validating");
  await expect(page.locator("#apply-progress-status")).toHaveText("Validating");

  finishCheck();
  await expect(item("firewall")).toHaveAttribute("aria-current", "step");
  await expect(item("firewall")).toHaveText("Applying firewall");
  await expect(item("validate")).toHaveClass(/is-done/);

  step = "wireguard";
  await expect(item("wireguard")).toHaveAttribute("aria-current", "step");
  await expect(item("wireguard")).toHaveText("Applying WireGuard");
  await expect(item("firewall")).toHaveClass(/is-done/);

  // A second press while it runs must not start a second Apply.
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#apply-bar-apply")).toHaveAttribute("aria-busy", "true");

  finishReload();
  await expect(item("done")).toHaveAttribute("aria-current", "step");
  await expect(item("done")).toHaveText("Done");
  await expect(page.locator("#apply-bar-apply")).not.toHaveAttribute("aria-busy", "true");
  await expect(page.locator("#apply-progress")).toBeHidden({ timeout: 8000 });
  await expect(page.locator("#apply-result")).toBeHidden();
});

test("a step the API does not report leaves the last one showing", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, CLEAN);
  await page.route("**/api/v1/reload/progress", (r) => r.fulfill({ status: 404, json: { error: "not found" } }));
  let finishReload = () => {};
  const reloadHeld = new Promise<void>((resolve) => (finishReload = resolve));
  await page.route("**/api/v1/reload", async (r) => {
    await reloadHeld;
    await r.fulfill({ json: { result: "reloaded" } });
  });
  await gotoRoute(page, origin, "routes");
  await page.locator("#apply-bar-apply").click();
  const firewall = page.locator("#apply-progress [data-apply-step='firewall']");
  await expect(firewall).toHaveAttribute("aria-current", "step");
  // Longer than one poll, so a poll that had moved it would show.
  await page.waitForTimeout(900);
  await expect(firewall).toHaveAttribute("aria-current", "step");
  finishReload();
  await expect(page.locator("#apply-progress [data-apply-step='done']")).toHaveAttribute("aria-current", "step");
});

test("a failed Apply marks the step it stopped on and keeps the bar", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, CLEAN);
  await page.route("**/api/v1/reload", (r) => r.fulfill({ status: 500, json: { error: "reload failed" } }));
  await gotoRoute(page, origin, "routes");
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#apply-progress [data-apply-step='firewall']")).toHaveClass(/is-failed/);
  await expect(page.locator("#apply-progress-status")).toHaveText("Applying firewall failed");
  await expect(page.locator("#apply-msg")).toHaveText("Apply failed");
  await expect(bar(page)).toBeVisible();
});

test("a failed check stops Apply and shows the result at the top", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 500 });
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, BROKEN);
  let applied = false;
  await page.route("**/api/v1/reload", (r) => {
    applied = true;
    return r.fulfill({ json: { result: "reloaded" } });
  });
  await gotoRoute(page, origin, "settings");
  await page.evaluate(() => window.scrollTo(0, 200));
  await page.locator("#apply-bar-apply").click();

  const panel = page.locator("#pending-validate-panel");
  await expect(panel).toHaveClass(/evu-alert--danger/);
  await expect(panel).toContainText("nft -c rejected");
  await expect(panel).toBeInViewport();
  await expect(page.locator("#apply-msg")).toContainText("Config check failed");
  await expect(page.locator("#apply-progress [data-apply-step='validate']")).toHaveClass(/is-failed/);
  await expect(page.locator("#apply-region #pending-validate-panel")).toHaveCount(1);
  expect(applied).toBe(false);
  await expect(bar(page)).toBeVisible();
});

test("Check config shows its result at the top without applying", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, CLEAN);
  let applied = false;
  await page.route("**/api/v1/reload", (r) => {
    applied = true;
    return r.fulfill({ json: { result: "reloaded" } });
  });
  await gotoRoute(page, origin, "pending");
  await page.locator("#pending-check-config").click();
  await expect(page.locator("#apply-region #pending-validate-panel")).toBeVisible();
  await expect(page.locator("#apply-msg")).toContainText("Config check passed");
  await expect(page.locator("#apply-progress")).toBeHidden();
  expect(applied).toBe(false);
});

test("a failed result follows the operator until the config changes", async ({ page }) => {
  let revision = "one";
  await stubPending(page, () => ({ pending: true, current_config_sha256: revision }));
  await stubValidate(page, BROKEN);
  await gotoRoute(page, origin, "routes");
  await page.locator("#apply-bar-apply").click();
  const panel = page.locator("#pending-validate-panel");
  await expect(panel).toBeVisible();

  // Going to fix it is exactly when the errors are needed.
  await page.locator(".nav-link[data-route='peers']").click();
  await expect(page.locator("#page-peers")).toBeVisible();
  await expect(panel).toBeVisible();
  await page.locator("#apply-bar-review").click();
  await expect(page.locator("#page-pending")).toBeVisible();
  await expect(panel).toBeVisible();

  revision = "two";
  await page.locator(".nav-link[data-route='peers']").click();
  await expect(page.locator("#page-peers")).toBeVisible();
  await expect(panel).toBeHidden();
  await expect(page.locator("#apply-result")).toBeHidden();
});

test("a clean result does not follow the operator", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, CLEAN);
  await gotoRoute(page, origin, "pending");
  await page.locator("#pending-check-config").click();
  await expect(page.locator("#pending-validate-panel")).toBeVisible();
  await page.locator(".nav-link[data-route='peers']").click();
  await expect(page.locator("#page-peers")).toBeVisible();
  await expect(page.locator("#apply-result")).toBeHidden();
});

test("Dismiss clears the result and keeps focus on the page", async ({ page }) => {
  await stubPending(page, () => ({ pending: true }));
  await stubValidate(page, BROKEN);
  await gotoRoute(page, origin, "routes");
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#apply-result")).toBeVisible();
  await page.locator("#apply-result-dismiss").click();
  await expect(page.locator("#apply-result")).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(bar(page)).toBeVisible();
});

test("page copy no longer repeats where to apply", async ({ page }) => {
  await gotoRoute(page, origin, "overview");
  const text = await page.evaluate(() => {
    const templates = [...document.querySelectorAll("template")].map((t) => t.content.textContent);
    return [document.body.textContent, ...templates].join("\n");
  });
  expect(text).not.toMatch(/apply\s+(from|on)\s+pending/i);
});
