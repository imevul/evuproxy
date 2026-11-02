/**
 * Confirm-or-revert Apply: "Applied. Keep these changes? Reverting in 60s". The revert
 * runs on the host, so what is tested here is the panel, and what Apply sends in each
 * mode. /apply/* is stubbed, since a session on the shared mock would refuse every other
 * spec's Apply. The host side is covered by Go tests and devtools/rollback-vm.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const CLEAN = { ok: true, warnings: [], detected_client_ip: "203.0.113.50", ip_detection_source: "direct" };
const RISKY = {
  ok: true,
  warnings: [{ code: "lockout_risk_source_allow", message: "Your IP is not in the source allowlist." }],
  detected_client_ip: "203.0.113.50",
  ip_detection_source: "direct",
};

function activeSession(remaining = 60) {
  return {
    phase: "active",
    started_at: "2026-11-02T08:00:00Z",
    deadline: new Date(Date.now() + remaining * 1000).toISOString(),
    timeout_seconds: 60,
    remaining_seconds: remaining,
  };
}

/** A small stand-in for the API's session state, driven by what the page sends. */
async function stubHost(page: Page, validate: Record<string, unknown>, initial: Record<string, unknown> = {}) {
  const host = {
    status: { confirm_enabled: true, confirm_timeout_seconds: 60, session: null, last_revert: null, ...initial } as Record<string, any>,
    reloadBodies: [] as string[],
    posts: [] as string[],
    refuse: "" as string,
  };
  await page.route("**/api/v1/pending", (route) => route.fulfill({ json: { pending: !host.status.session } }));
  await page.route("**/api/v1/validate", (route) => route.fulfill({ json: validate }));
  await page.route("**/api/v1/apply/session", (route) => route.fulfill({ json: host.status }));
  await page.route("**/api/v1/reload", (route) => {
    host.reloadBodies.push(route.request().postData() || "");
    const body = JSON.parse(route.request().postData() || "{}");
    if (body.confirm_timeout_seconds) host.status.session = activeSession(body.confirm_timeout_seconds);
    return route.fulfill({ json: { result: "reloaded", session: host.status.session } });
  });
  for (const action of ["confirm", "revert", "reverted/restore", "reverted/dismiss"]) {
    await page.route(`**/api/v1/apply/${action}`, (route) => {
      host.posts.push(action);
      if (host.refuse) return route.fulfill({ status: 409, json: { error: host.refuse, error_code: "rollback_failed" } });
      if (action === "confirm") host.status.session = null;
      if (action === "revert") {
        host.status.session = null;
        host.status.last_revert = { at: "2026-11-02T08:01:00Z", reason: "manual", config_available: true };
      }
      if (action.startsWith("reverted/")) host.status.last_revert = null;
      return route.fulfill({ json: { result: "ok" } });
    });
  }
  return host;
}

const panel = (page: Page) => page.locator("#apply-session");

test.beforeEach(async ({ page }) => {
  await seed(page, { scheme: "light" });
});

test("Apply asks for confirmation and counts down, with focus on Keep", async ({ page }) => {
  const host = await stubHost(page, CLEAN);
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toBeHidden();

  await page.locator("#apply-bar-apply").click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText("Applied. Keep these changes?");
  await expect(page.locator("#apply-session-detail")).toContainText(/Reverting in (60|59|58)s/);
  await expect(page.locator("#apply-session-keep")).toBeFocused();
  await expect(page.locator("#apply-session-status")).toContainText("Keep these changes?");
  await expect(page.locator("#apply-session-check")).toContainText("Keep opens a new connection");
  await expect(page.locator("#apply-session-check")).toContainText("SSH tunnel or a proxy");
  await expect(page.locator("#apply-session-keep")).toHaveAttribute("aria-describedby", "apply-session-check");
  expect(JSON.parse(host.reloadBodies[0])).toEqual({ confirm_timeout_seconds: 60 });
});

test("Keep ends the session and says so", async ({ page }) => {
  const host = await stubHost(page, CLEAN);
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await page.locator("#apply-session-keep").click();
  await expect(panel(page)).toBeHidden();
  expect(host.posts).toEqual(["confirm"]);
  await expect(page.locator("#main-content")).toBeFocused();
  await expect(page.getByText("Changes kept")).toBeVisible();
});

test("Revert now offers the rejected config back", async ({ page }) => {
  const host = await stubHost(page, CLEAN);
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await page.locator("#apply-session-revert").click();
  await expect(panel(page)).toContainText("Reverted to the last confirmed config.");
  await expect(panel(page)).toContainText("You chose to revert it.");
  await expect(page.locator("#apply-session-keep")).toBeHidden();
  await expect(page.locator("#apply-session-check")).toBeHidden();

  await page.locator("#apply-session-restore").click();
  await expect(panel(page)).toBeHidden();
  expect(host.posts).toEqual(["revert", "reverted/restore"]);
});

test("a lockout risk stays on screen with no acknowledgement to tick", async ({ page }) => {
  await stubHost(page, RISKY);
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator("#pending-validate-warnings")).toContainText("source allowlist");
  await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);

  await page.locator("#apply-session-keep").click();
  await expect(page.locator("#pending-validate-panel")).toHaveClass(/is-hidden/);
});

test("with the setting off, Apply stays one-way and keeps the acknowledgement", async ({ page }) => {
  const host = await stubHost(page, RISKY, { confirm_enabled: false });
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#pending-lockout-ack-wrap")).not.toHaveClass(/is-hidden/);
  expect(host.reloadBodies).toEqual([]);

  await page.locator("#pending-lockout-ack").check();
  await page.locator("#apply-bar-apply").click();
  await expect.poll(() => host.reloadBodies).toEqual([""]);
  await expect(panel(page)).toBeHidden();
});

test("an API without the session route gets the old Apply", async ({ page }) => {
  const host = await stubHost(page, CLEAN);
  await page.route("**/api/v1/apply/session", (route) => route.fulfill({ status: 404, body: "404 page not found" }));
  await gotoRoute(page, origin, "overview");
  await page.locator("#apply-bar-apply").click();
  await expect.poll(() => host.reloadBodies).toEqual([""]);
});

test("an API that can't say which mode to use stops the Apply", async ({ page }) => {
  const host = await stubHost(page, CLEAN);
  await gotoRoute(page, origin, "overview");
  await page.route("**/api/v1/apply/session", (route) => route.fulfill({ status: 500, json: { error: "could not read apply session" } }));
  await page.locator("#apply-bar-apply").click();
  await expect(page.locator("#apply-msg")).toContainText("could not read apply session");
  expect(host.reloadBodies).toEqual([]);
});

test("a session started elsewhere shows on load, even with the setting off", async ({ page }) => {
  const host = await stubHost(page, CLEAN, { confirm_enabled: false, session: activeSession(30) });
  await gotoRoute(page, origin, "routes");
  await expect(panel(page)).toContainText("Applied. Keep these changes?");
  await expect(page.locator("#apply-session-detail")).toContainText(/Reverting in (30|29|28|27)s/);
  await expect(page.locator("#apply-session-keep")).not.toBeFocused();

  // Applying again during the window has to go through the session, or it would be refused.
  await page.evaluate(() => {
    document.getElementById("apply-bar")!.hidden = false;
  });
  await page.locator("#apply-bar-apply").click();
  await expect.poll(() => host.reloadBodies).toEqual(['{"confirm_timeout_seconds":60}']);
});

test("a revert that happened while nobody watched is reported", async ({ page }) => {
  await stubHost(page, CLEAN, {
    last_revert: { at: "2026-11-02T08:01:00Z", reason: "timeout", config_available: true },
  });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toContainText("It wasn't confirmed in time.");
  await expect(panel(page)).toContainText("The rejected config has been kept.");
  await expect(page.locator("#apply-session-restore")).toBeVisible();
  await page.locator("#apply-session-dismiss").click();
  await expect(panel(page)).toBeHidden();
});

test("the page notices a session ending by itself", async ({ page }) => {
  const host = await stubHost(page, CLEAN, { session: activeSession(5) });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toContainText("Keep these changes?");
  host.status.session = null;
  host.status.last_revert = { at: "2026-11-02T08:01:00Z", reason: "timeout", config_available: true };
  await expect(panel(page)).toContainText("It wasn't confirmed in time.", { timeout: 8000 });
  await expect(page.locator("#apply-session-status")).toHaveText("Reverted to the last confirmed config.");
});

test("a failed revert is a danger banner with a retry", async ({ page }) => {
  const host = await stubHost(page, CLEAN, {
    session: { ...activeSession(0), phase: "failed", failure: "nft load: exit 1" },
  });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toHaveClass(/evu-alert--danger/);
  await expect(panel(page)).toContainText("may still be running the rejected config");
  await expect(panel(page)).toContainText("nft load: exit 1");
  await expect(page.locator("#apply-session-keep")).toBeHidden();
  await expect(page.locator("#apply-session-revert")).toHaveText("Retry revert");

  host.refuse = "reverting the last Apply failed: still broken";
  await page.locator("#apply-session-revert").click();
  await expect(page.locator("#apply-session-note")).toContainText("still broken");
  await expect(panel(page)).toHaveClass(/evu-alert--danger/);

  host.refuse = "";
  await page.locator("#apply-session-revert").click();
  await expect(panel(page)).toContainText("Reverted to the last confirmed config.");
  await expect(panel(page)).toHaveClass(/evu-alert--info/);
});

test("losing the API during the window says the host reverts by itself", async ({ page }) => {
  await stubHost(page, CLEAN, { session: activeSession(30) });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toContainText("Keep these changes?");
  await page.route("**/api/v1/apply/session", (route) => route.abort());
  await expect(page.locator("#apply-session-note")).toContainText("the host reverts by itself", { timeout: 35000 });
  await expect(page.locator("#apply-session-detail")).toContainText("Reverting in");
});

test("the prompt shows right after a cut, while the screen's refresh gets no answer", async ({ page }) => {
  await stubHost(page, CLEAN);
  await gotoRoute(page, origin, "overview");
  // Only the Apply's own request, on a connection opened before the cut, comes back.
  await page.route("**/api/v1/reload", async (route) => {
    await page.route("**/api/v1/pending", () => {});
    await page.route("**/api/v1/overview", () => {});
    await page.route("**/api/v1/apply/session", () => {});
    return route.fulfill({ json: { result: "reloaded", session: activeSession(60) } });
  });
  await page.locator("#apply-bar-apply").click();
  await expect(panel(page)).toContainText("Applied. Keep these changes?");
  await expect(page.locator("#apply-session-keep")).toBeFocused();
});

test("a Keep that gets no answer says so, stops waiting and keeps the countdown", async ({ page }) => {
  test.setTimeout(60000);
  const host = await stubHost(page, CLEAN, { session: activeSession(45) });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toContainText("Keep these changes?");
  // What a firewall dropping the new connection looks like from here: nothing ever comes back.
  await page.route("**/api/v1/apply/confirm", () => {});
  await page.route("**/api/v1/apply/session", () => {});
  await page.locator("#apply-session-keep").click();
  const note = page.locator("#apply-session-note");
  await expect(note).toContainText("No answer from the host over a new connection", { timeout: 20000 });
  await expect(note).toHaveClass(/err/);
  await expect(page.locator("#apply-session-detail")).toContainText("Reverting in");
  await expect(page.locator("#apply-session-keep")).toBeVisible();
  await expect(page.getByText("Changes kept")).toBeHidden();
  expect(host.posts).toEqual([]);
  // The hung re-read must not replace the message with the milder one when it gives up too.
  await page.waitForTimeout(16000);
  await expect(note).toContainText("No answer from the host over a new connection");
});

test("polling that gets no answer gives up and says the host reverts by itself", async ({ page }) => {
  await stubHost(page, CLEAN, { session: activeSession(45) });
  await gotoRoute(page, origin, "overview");
  await expect(panel(page)).toContainText("Keep these changes?");
  await page.route("**/api/v1/apply/session", () => {});
  await expect(page.locator("#apply-session-note")).toContainText("the host reverts by itself", { timeout: 25000 });
});

test("Settings has a switch for the setting, saved like the other switches", async ({ page }) => {
  await page.route("**/api/v1/apply/session", (route) =>
    route.fulfill({ json: { confirm_enabled: false, confirm_timeout_seconds: 60, session: null, last_revert: null } })
  );
  let config: Record<string, any> = {};
  await page.route("**/api/v1/config", async (route) => {
    if (route.request().method() === "PUT") {
      config = JSON.parse(route.request().postData() || "{}");
      return route.fulfill({ json: { result: "saved" }, headers: { ETag: '"after"' } });
    }
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ json: body, headers: { ETag: '"before"' } });
  });
  await gotoRoute(page, origin, "settings");
  const toggle = page.locator("#settings-apply-confirm");
  await expect(toggle).not.toBeChecked();
  await page.locator("label:has(#settings-apply-confirm)").click();
  await expect.poll(() => config.apply).toEqual({ confirm: true });
  await expect(page.getByText("Revert Apply unless confirmed: on")).toBeVisible();
});
