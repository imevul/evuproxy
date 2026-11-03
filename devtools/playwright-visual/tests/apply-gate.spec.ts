/**
 * The pre-apply lockout gate.
 *
 * Applying a config can cut the operator's own access to the host (SSH or this
 * admin UI). The backend reports that as `lockout_risk_*` warnings from
 * POST /validate; these tests cover the UI actually honouring them.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

/** Holds the Apply bar on screen, whatever earlier specs left in the mock. */
async function stubPending(page: import("@playwright/test").Page, pending: boolean) {
  await page.route("**/api/v1/pending", (route) => route.fulfill({ json: { pending } }));
}

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
    await stubPending(page, true);
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
    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--warning/);
    await expect(page.locator("#pending-lockout-ack-wrap")).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#apply-msg")).toContainText(/may lock you out/i);
    expect(applied, "apply must not reach the host before acknowledgement").toBe(false);

    // Still blocked while the acknowledgement is unticked.
    await page.locator("#apply-bar-apply").click();
    expect(applied).toBe(false);
    await expect(page.locator("#apply-msg")).toContainText(/tick the box/i);

    await page.locator("#pending-lockout-ack").check();
    await page.locator("#apply-bar-apply").click();
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

    await page.locator("#apply-bar-apply").click();
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

    await page.locator("#apply-bar-apply").click();
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
    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#apply-msg")).toContainText(/unexpected response/i);
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

    await page.locator("#apply-bar-apply").click();
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

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#pending-validate-warnings")).toContainText("Geoblocking");
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    expect(applied, "the earlier tick must not authorise the new risk").toBe(false);
  });

  test("Refresh invalidates an earlier acknowledgement", async ({ page }) => {
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

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    expect(applied).toBe(false);
  });
});

/*
 * These go through the mock's real /validate logic rather than a stubbed body.
 * The edit is sent as a draft, which the mock does not persist, so the shared mock
 * state stays untouched for other specs.
 */
test.describe("inbound rule lockout risk", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await stubPending(page, true);
  });

  type InboundRule = { dport: string; disabled?: boolean };

  async function validateDraft(
    page: import("@playwright/test").Page,
    edit: (rules: InboundRule[]) => InboundRule[]
  ) {
    await page.route("**/api/v1/validate", async (route) => {
      const res = await page.request.get(`${origin}/api/v1/config`, {
        headers: { Authorization: `Bearer ${token()}` },
      });
      const cfg = await res.json();
      cfg.input_allows = edit(cfg.input_allows);
      // The mock's geo warning also engages the gate, so it would hide a missing inbound risk.
      cfg.geo = { ...cfg.geo, enabled: false };
      await route.continue({
        postData: JSON.stringify(cfg),
        headers: { ...route.request().headers(), "content-type": "application/json" },
      });
    });
  }

  const forSSH = (r: InboundRule) => r.dport === "22";

  for (const [name, edit] of [
    ["disabling", (rules: InboundRule[]) => rules.map((r) => (forSSH(r) ? { ...r, disabled: true } : r))],
    ["removing", (rules: InboundRule[]) => rules.filter((r) => !forSSH(r))],
  ] as const) {
    test(`${name} the SSH rule requires acknowledgement before Apply`, async ({ page }) => {
      await validateDraft(page, edit);
      await gotoRoute(page, origin, "pending");

      let applied = false;
      await page.route("**/api/v1/reload", (route) => {
        applied = true;
        return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
      });

      await page.locator("#apply-bar-apply").click();
      await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--warning/);
      await expect(page.locator("#pending-validate-warnings")).toContainText("TCP port 22 (SSH)");
      await expect(page.locator("#pending-lockout-ack-wrap")).not.toHaveClass(/is-hidden/);
      expect(applied, "apply must not reach the host before acknowledgement").toBe(false);

      await page.locator("#pending-lockout-ack").check();
      await page.locator("#apply-bar-apply").click();
      await expect.poll(() => applied).toBe(true);
    });
  }

  test("disabling an unrelated rule raises no inbound risk", async ({ page }) => {
    await validateDraft(page, (rules) =>
      rules.map((r) => (r.dport.includes("443") ? { ...r, disabled: true } : r))
    );
    await gotoRoute(page, origin, "pending");

    await page.locator("#pending-check-config").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--success/);
    await expect(page.locator("#pending-validate-warnings")).not.toContainText("TCP port");
    await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);
  });
});

/*
 * The bar's Apply and the one on Pending are two buttons on one /reload endpoint,
 * so both need the gate, on any page. Overview matters most: the maintenance-mode
 * copy there tells the operator to Apply, and maintenance mode is itself a lockout risk.
 */
test.describe("Apply away from Pending changes", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await stubPending(page, true);
  });

  test("a lockout risk requires acknowledgement before applying", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#apply-bar-apply").click();
    const result = page.locator("#apply-region");
    await expect(result).toContainText(/lock you out/i);
    await expect(result).toContainText("source allowlist");
    await expect(page.locator("#pending-lockout-ack")).toBeFocused();
    expect(applied, "apply must wait for acknowledgement").toBe(false);

    await page.locator("#pending-lockout-ack").check();
    await page.locator("#apply-bar-apply").click();
    await expect.poll(() => applied).toBe(true);
  });

  test("a config change after the tick revokes the acknowledgement", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#apply-bar-apply").click();
    await page.locator("#pending-lockout-ack").check();

    // Someone else saved a config carrying a different risk while the operator
    // was reading the warnings.
    await stubValidate(page, {
      ok: true,
      warnings: [{ code: "lockout_risk_geo", message: "Geoblocking may block your address." }],
      detected_client_ip: "203.0.113.50",
      ip_detection_source: "direct",
    });

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#pending-validate-warnings")).toContainText("Geoblocking");
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    expect(applied).toBe(false);
  });

  test("a clean check applies without a prompt", async ({ page }) => {
    await stubValidate(page, CLEAN);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#apply-bar-apply").click();
    await expect.poll(() => applied).toBe(true);
    await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);
  });

  test("a failed check blocks the apply", async ({ page }) => {
    await stubValidate(page, BROKEN);
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#apply-msg")).toContainText(/Config check failed/i);
    expect(applied).toBe(false);
  });
});

/*
 * The server side of the gate: /reload applies only the file /validate passed. These
 * go through the mock's real answers, because a stubbed 409 would prove only that the
 * stub was called. Nothing here gets as far as applying, apart from the two API tests
 * that apply inside a session, revert it and restore the config.
 */
test.describe("server-side apply gate", () => {
  const url = (path: string) => `${origin}/api/v1${path}`;
  const auth = () => ({ Authorization: `Bearer ${token()}` });

  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await stubPending(page, true);
  });

  test("Apply sends the hash its check returned, and never force", async ({ page }) => {
    await stubValidate(page, { ...CLEAN, config_hash: "hash-from-check" });
    await gotoRoute(page, origin, "overview");

    let sent: unknown;
    await page.route("**/api/v1/reload", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { result: "reloaded" } });
    });

    await page.locator("#apply-bar-apply").click();
    await expect.poll(() => sent).toEqual({ config_hash: "hash-from-check" });
  });

  test("a confirmed Apply sends the hash along with its timeout", async ({ page }) => {
    await stubValidate(page, { ...CLEAN, config_hash: "hash-from-check" });
    await page.route("**/api/v1/apply/session", (route) =>
      route.fulfill({
        json: { confirm_enabled: true, confirm_timeout_seconds: 60, session: null, last_revert: null },
      })
    );
    await gotoRoute(page, origin, "overview");

    let sent: unknown;
    await page.route("**/api/v1/reload", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ status: 500, json: { error: "reload failed" } });
    });

    await page.locator("#apply-bar-apply").click();
    await expect
      .poll(() => sent)
      .toEqual({ config_hash: "hash-from-check", confirm_timeout_seconds: 60 });
  });

  // Each click's hash has to come from that click's check, not from an earlier one.
  test("Apply sends the hash of the check it just ran", async ({ page }) => {
    await stubValidate(page, { ...CLEAN, config_hash: "from-the-button" });
    await gotoRoute(page, origin, "pending");
    await page.locator("#pending-check-config").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--success/);

    await stubValidate(page, { ...CLEAN, config_hash: "from-apply" });
    let sent: unknown;
    await page.route("**/api/v1/reload", (route) => {
      sent = route.request().postDataJSON();
      return route.fulfill({ json: { result: "reloaded" } });
    });

    await page.locator("#apply-bar-apply").click();
    await expect.poll(() => sent).toEqual({ config_hash: "from-apply" });
  });

  test("a config saved after the check stops Apply, says so, and Apply works again", async ({ page }) => {
    // The mock's real hash, without the geo warning that would stop at the tick first.
    await page.route("**/api/v1/validate", async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), warnings: [] } });
    });
    await gotoRoute(page, origin, "pending");

    // The mock's real /validate runs, then a save lands before /reload gets there: the
    // hash no longer matches. Sending a stale one has the same effect without changing
    // the config the other specs share.
    let reloads = 0;
    const sent: unknown[] = [];
    await page.route("**/api/v1/reload", async (route) => {
      reloads += 1;
      sent.push(route.request().postDataJSON());
      if (reloads === 1) {
        await route.continue({
          postData: JSON.stringify({ config_hash: "0".repeat(64) }),
          headers: { ...route.request().headers(), "content-type": "application/json" },
        });
        return;
      }
      await route.fulfill({ json: { result: "reloaded" } });
    });

    await page.locator("#pending-check-config").click();
    await expect(page.locator("#pending-validate-panel")).toBeVisible();
    const pendingRefreshed = page.waitForResponse("**/api/v1/pending");
    await page.locator("#apply-bar-apply").click();

    const msg = page.locator("#apply-msg");
    await expect(msg).toContainText(/changed after this check/i);
    await expect(msg).toContainText(/nothing was applied/i);
    await expect(msg).toHaveClass(/err/);
    await expect(page.locator("#apply-progress-status")).toHaveText("Validating failed");
    await pendingRefreshed;
    // Still there once the refresh has seen the new revision.
    await expect(msg).toContainText(/changed after this check/i);
    await expect(page.getByText("Applied to host")).toHaveCount(0);

    // No retry of its own: the operator looks first, and force is never the way round it.
    expect(reloads).toBe(1);
    expect(JSON.stringify(sent)).not.toContain("force");

    await page.locator("#apply-bar-apply").click();
    await expect.poll(() => reloads).toBe(2);
    await expect(page.locator("#apply-progress-status")).toHaveText("Done");
  });

  test("a config saved after the check revokes the acknowledgement", async ({ page }) => {
    await stubValidate(page, { ...RISKY, config_hash: "checked" });
    await gotoRoute(page, origin, "overview");
    await page.route("**/api/v1/reload", (route) =>
      route.fulfill({
        status: 409,
        json: { error: "config.yaml changed", error_code: "config_hash_mismatch" },
      })
    );

    await page.locator("#apply-bar-apply").click();
    await page.locator("#pending-lockout-ack").check();
    await page.locator("#apply-bar-apply").click();

    await expect(page.locator("#apply-msg")).toContainText(/changed after this check/i);
    await expect(page.locator("#pending-lockout-ack")).not.toBeChecked();
    await expect(page.locator("#pending-lockout-ack-wrap")).toHaveClass(/is-hidden/);
  });

  // Reaches the mock: a UI older than the API sends this, and has to see why it was refused.
  test("an Apply with no hash is refused with the host's reason", async ({ page }) => {
    await stubValidate(page, CLEAN);
    await gotoRoute(page, origin, "overview");

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#apply-msg")).toContainText(/config_hash/);
    await expect(page.locator("#apply-progress-status")).toHaveText("Applying firewall failed");
  });

  // A hash of the wrong type is a response we don't understand, like the rest of that rule.
  test("a config_hash that isn't a string blocks Apply", async ({ page }) => {
    await stubValidate(page, { ...CLEAN, config_hash: 12345 });
    await gotoRoute(page, origin, "overview");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ json: { result: "reloaded" } });
    });

    await page.locator("#apply-bar-apply").click();
    await expect(page.locator("#apply-msg")).toContainText(/unexpected response/i);
    expect(applied).toBe(false);
  });

  test("the mock answers like the API", async ({ request }) => {
    const reload = (data?: unknown) =>
      request.post(url("/reload"), { headers: auth(), ...(data ? { data } : {}) });
    const check = await request.post(url("/validate"), { headers: auth() });
    const { config_hash: hash } = await check.json();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    const etag = (await request.get(url("/config"), { headers: auth() })).headers().etag;
    expect(etag).toBe(`"${hash}"`);

    const noHash = await reload();
    expect(noHash.status()).toBe(409);
    expect((await noHash.json()).error_code).toBe("config_hash_required");

    const notForced = await reload({ force: false });
    expect(notForced.status()).toBe(409);
    expect((await notForced.json()).error_code).toBe("config_hash_required");

    const stale = await reload({ config_hash: "0".repeat(64) });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error_code).toBe("config_hash_mismatch");

    const both = await reload({ force: true, config_hash: hash });
    expect(both.status()).toBe(400);
    expect((await both.json()).error_code).toBe("invalid_reload_body");

    // A draft isn't what a reload applies, so it gets nothing to acknowledge.
    const cfg = await (await request.get(url("/config"), { headers: auth() })).json();
    const draft = await request.post(url("/validate"), { headers: auth(), data: cfg });
    expect((await draft.json()).config_hash).toBeUndefined();
  });

  for (const [name, ack] of [
    ["a matching hash", (hash: string) => ({ config_hash: hash })],
    ["force", () => ({ force: true })],
  ] as const) {
    test(`the mock applies with ${name}`, async ({ request }) => {
      const getJson = async (path: string) =>
        (await request.get(url(path), { headers: auth() })).json();
      const saved = await getJson("/config");
      const pendingBefore = await getJson("/pending");
      const check = await request.post(url("/validate"), { headers: auth() });
      const { config_hash: hash } = await check.json();
      // In a confirm session, because the mock is shared: reverting restores applied history.
      const applied = await request.post(url("/reload"), {
        headers: auth(),
        data: { ...ack(hash), confirm_timeout_seconds: 600 },
      });
      try {
        expect(applied.status()).toBe(200);
      } finally {
        // The revert also puts the config back to the applied one, so restore the saved one.
        await request.post(url("/apply/revert"), { headers: auth() });
        await request.post(url("/apply/reverted/dismiss"), { headers: auth() });
        await request.put(url("/config"), { headers: auth(), data: saved });
      }
      expect(await getJson("/pending")).toEqual(pendingBefore);
    });
  }
});

/* With nothing waiting there is no bar, and Pending's own Apply takes its place. */
test.describe("re-applying with nothing pending", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await stubPending(page, false);
  });

  test("a lockout risk blocks it until acknowledged", async ({ page }) => {
    await stubValidate(page, RISKY);
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect(page.locator("#apply-msg")).toContainText(/may lock you out/i);
    expect(applied).toBe(false);

    await page.locator("#pending-lockout-ack").check();
    await page.locator("#pending-apply").click();
    await expect.poll(() => applied).toBe(true);
  });

  test("a failed check blocks it", async ({ page }) => {
    await stubValidate(page, BROKEN);
    await gotoRoute(page, origin, "pending");

    let applied = false;
    await page.route("**/api/v1/reload", (route) => {
      applied = true;
      return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    });

    await page.locator("#pending-apply").click();
    await expect(page.locator("#pending-validate-panel")).toHaveClass(/evu-alert--danger/);
    expect(applied).toBe(false);
  });
});
