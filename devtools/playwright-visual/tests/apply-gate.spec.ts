/**
 * The pre-apply lockout gate on Pending changes.
 *
 * Applying a config can cut the operator's own access to the host (SSH or this
 * admin UI). The backend reports that as `lockout_risk_*` warnings from
 * POST /validate; these tests cover the UI actually honouring them.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

/** Replaces /validate so each test controls the risk the UI is reacting to. */
async function stubValidate(
  page: import("@playwright/test").Page,
  body: Record<string, unknown>
) {
  await page.route("**/api/v1/validate", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(body),
    })
  );
}

const CLEAN = {
  ok: true,
  warnings: [],
  detected_client_ip: "203.0.113.50",
  ip_detection_source: "direct",
};

const RISKY = {
  ok: true,
  warnings: [
    { code: "lockout_risk_source_allow", message: "Your IP is not in the source allowlist." },
  ],
  detected_client_ip: "203.0.113.50",
  ip_detection_source: "direct",
};

const BROKEN = {
  ok: false,
  errors: [{ code: "nft_syntax", message: "nft -c rejected the ruleset." }],
  warnings: [],
  detected_client_ip: "203.0.113.50",
  ip_detection_source: "direct",
};

test.describe("pre-apply check", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("Check config reports the detected client IP and a clean result", async ({ page }) => {
    await stubValidate(page, CLEAN);
    await gotoRoute(page, origin, "pending");

    await page.locator("#pending-check-config").click();

    const panel = page.locator("#pending-validate-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toHaveClass(/evu-alert--success/);
    await expect(page.locator("#pending-client-ip")).toContainText("203.0.113.50");
    await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);
  });

  test("a lockout risk blocks Apply until it is acknowledged", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    // Straight to Apply without checking first: the gate must still engage.
    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--warning/);
    await expect(page.locator("#pending-lockout-ack-wrap")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#pending-msg")).toContainText(/may lock you out/i);
    expect(applied, "apply must not reach the host before acknowledgement").toBe(false);

    // Still blocked while the acknowledgement is unticked.
    await page.locator("#pending-apply").click();
    expect(applied).toBe(false);
    await expect(page.locator("#pending-msg")).toContainText(/tick the box/i);

    await page.locator("#pending-lockout-ack").check();
    await page.locator("#pending-apply").click();
    await expect.poll(() => applied).toBe(true);
  });

  test("a failed check blocks Apply outright", async ({ page }) => {
    await stubValidate(page, BROKEN);
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--danger/);
    await expect(page.locator("#pending-validate-warnings")).toContainText("nft -c rejected");
    expect(applied).toBe(false);
    // No acknowledgement is offered: errors are to be fixed, not accepted.
    await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);
  });

  test("a clean check lets Apply through", async ({ page }) => {
    await stubValidate(page, CLEAN);
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect.poll(() => applied).toBe(true);
  });

  // The gate reads the response, not a "we ran a check" flag. A 200 whose shape
  // we do not recognise (proxy interstitial, future API change) must not read as
  // "no errors, no warnings".
  test("an unrecognised check response blocks Apply", async ({ page }) => {
    await stubValidate(page, { unexpected: true });
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    // Ask for the check first, then apply: the ordering that used to set the
    // flag and let every later gate be skipped.
    await page.locator("#pending-check-config").click();
    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-msg")).toContainText(/unexpected response/i);
    expect(applied).toBe(false);
  });

  test("a failed check carrying a lockout risk shows both and blocks", async ({ page }) => {
    await stubValidate(page, {
      ok: false,
      errors: [{ code: "nft_syntax", message: "nft -c rejected the ruleset." }],
      warnings: [
        { code: "lockout_risk_source_allow", message: "Your IP is not in the source allowlist." },
      ],
      detected_client_ip: "203.0.113.50",
      ip_detection_source: "direct",
    });
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    const list = page.locator("#pending-validate-warnings");
    await expect(list).toContainText("nft -c rejected");
    await expect(list).toContainText("source allowlist");
    expect(applied).toBe(false);
  });

  // An acknowledgement is given for a specific set of warnings. If the config
  // moves between the tick and Apply, the re-check produces different warnings
  // and the tick must not carry over to them.
  test("an acknowledgement does not carry over to different warnings", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "pending");

    await page.locator("#pending-check-config").click();
    await page.locator("#pending-lockout-ack").check();

    // Something else saved a config with a different risk in the meantime.
    await stubValidate(page, {
      ok: true,
      warnings: [
        { code: "lockout_risk_geo", message: "Geoblocking may block your address." },
      ],
      detected_client_ip: "203.0.113.50",
      ip_detection_source: "direct",
    });

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-validate-warnings")).toContainText("Geoblocking");
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    expect(applied, "the earlier tick must not authorise the new risk").toBe(false);
  });

  test("refreshing the preview invalidates an earlier acknowledgement", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "pending");

    await page.locator("#pending-check-config").click();
    await page.locator("#pending-lockout-ack").check();

    // The config underneath may have moved, so the tick no longer applies.
    await page.locator("#pending-refresh").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/is-hidden/);

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    expect(applied).toBe(false);
  });
});

/*
 * Overview's "Reload config" posts to the same /reload endpoint as Apply, so it
 * needs the same gate. It used to have none — and the maintenance-mode copy right
 * next to it tells the operator to press it, while maintenance mode is itself one
 * of the lockout risks.
 */
test.describe("Overview reload", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("a lockout risk requires confirmation before reloading", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#btn-reload").click();
    const dialog = page.locator("#confirm-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/lock you out/i);
    await expect(dialog).toContainText("source allowlist");
    expect(applied, "reload must wait for confirmation").toBe(false);

    await page.locator("#confirm-modal-cancel").click();
    expect(applied).toBe(false);

    await page.locator("#btn-reload").click();
    await page.locator("#confirm-modal-ok").click();
    await expect.poll(() => applied).toBe(true);
  });

  test("a config change while the dialog is open revokes the confirmation", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#btn-reload").click();
    await expect(page.locator("#confirm-modal")).toBeVisible();

    // Someone else saved a config carrying a different risk while the operator
    // was reading the dialog.
    await stubValidate(page, {
      ok: true,
      warnings: [{ code: "lockout_risk_geo", message: "Geoblocking may block your address." }],
      detected_client_ip: "203.0.113.50",
      ip_detection_source: "direct",
    });

    await page.locator("#confirm-modal-ok").click();
    await expect(page.locator("#overview-action-msg")).toContainText(/config changed since you confirmed/i);
    expect(applied).toBe(false);
  });

  test("a clean check reloads without a prompt", async ({ page }) => {
    await stubValidate(page, CLEAN);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#btn-reload").click();
    await expect.poll(() => applied).toBe(true);
    await expect(page.locator("#confirm-modal")).toBeHidden();
  });

  test("a failed check blocks the reload", async ({ page }) => {
    await stubValidate(page, BROKEN);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#btn-reload").click();
    await expect(page.locator("#overview-action-msg")).toContainText(/Config check failed/i);
    expect(applied).toBe(false);
  });
});
