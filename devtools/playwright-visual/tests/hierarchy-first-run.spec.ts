/**
 * Hierarchy, wording, first run, titles and motion (ENG-143).
 *
 * API responses that the mock cannot produce on demand (zero peers, set-style
 * dports, known byte counts) are stubbed per test. Only the row removal test
 * writes config, and it puts the config back.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

/** Rewrites one JSON API response on its way to the page. */
async function patchApi(page: Page, path: string, patch: (body: any) => unknown): Promise<void> {
  await page.route(`**/api${path}`, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const res = await route.fetch();
    await route.fulfill({ response: res, json: patch(await res.json()) });
  });
}

/** How many transitions are running on the modal and its panel right now. */
function modalTransitionCount(page: Page, selector: string): Promise<number> {
  return page.evaluate((sel) => {
    const modal = document.querySelector(sel)!;
    return modal.getAnimations({ subtree: true }).length;
  }, selector);
}

test.describe("no token", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("evuproxy_gh_release_check_v1", JSON.stringify({ t: Date.now(), tag: "v0.0.0" })));
  });

  test("lands on the token page, neutral, from any route", async ({ page }) => {
    for (const route of ["overview", "routes"]) {
      await page.goto(`${origin}/#/${route}`);
      await expect(page.locator("#page-token")).toBeVisible();
      await expect(page.locator("#page-overview")).toBeHidden();
      await expect(page.locator("#token-not-connected")).toBeVisible();
      const pill = page.locator("#api-status");
      await expect(pill).toHaveText("Not connected");
      await expect(pill).not.toHaveClass(/evu-pill--err/);
    }
  });

  test("saving a working token moves on to Overview", async ({ page }) => {
    await page.goto(`${origin}/#/overview`);
    await page.locator("#token").fill("dev");
    await page.locator("#save-token").click();
    await expect(page.locator("#page-overview")).toBeVisible();
    await expect(page.locator("#api-status")).toHaveText("API OK");
  });

  test("saving a rejected token says so and stays on the token page", async ({ page }) => {
    await page.goto(`${origin}/#/token`);
    await page.locator("#token").fill("not-the-token");
    await page.locator("#save-token").click();
    await expect(page.locator("#auth-msg")).toContainText("did not accept");
    await expect(page.locator("#page-token")).toBeVisible();
  });
});

test.describe("connected", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("zero peers shows the checklist on Overview, in order", async ({ page }) => {
    await patchApi(page, "/v1/config", (cfg) => ({ ...cfg, peers: [] }));
    await gotoRoute(page, origin, "overview");
    const steps = page.locator(".first-run-step a");
    await expect(steps).toHaveText(["Set the server endpoint", "Add a peer", "Add a route", "Apply"]);
    await expect(steps.nth(1)).toHaveAttribute("href", "#/peers");
  });

  test("the checklist stays through setup and leaves once applied", async ({ page }) => {
    // Once only: the page clears this flag itself, and a reload must not bring it back.
    await page.addInitScript(() => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("evuproxy_first_run", "1");
    });
    await patchApi(page, "/v1/pending", (p) => ({ ...p, pending: true }));
    await gotoRoute(page, origin, "overview");
    await expect(page.locator(".first-run-step.is-done a", { hasText: "Add a peer" })).toBeVisible();

    await page.unroute("**/api/v1/pending");
    await patchApi(page, "/v1/pending", (p) => ({ ...p, pending: false }));
    await page.reload();
    await expect(page.locator(".overview-dash-activity")).toBeVisible();
    await expect(page.locator(".overview-first-run")).toHaveCount(0);
  });

  test("an established host never sees the checklist", async ({ page }) => {
    await patchApi(page, "/v1/pending", (p) => ({ ...p, pending: true }));
    await gotoRoute(page, origin, "overview");
    await expect(page.locator("#overview-cards .evu-card").first()).toBeVisible();
    await expect(page.locator(".overview-first-run")).toHaveCount(0);
  });

  test("Add is primary and Refresh is quiet", async ({ page }) => {
    for (const [route, add, refresh] of [
      ["peers", "#peers-add-start", "#peers-refresh"],
      ["routes", "#routes-add", "#routes-refresh"],
      ["inbound", "#inbound-add", "#inbound-refresh"],
    ] as const) {
      await gotoRoute(page, origin, route);
      await expect(page.locator(add)).toHaveClass(/evu-btn--primary/);
      await expect(page.locator(refresh)).toHaveClass(/evu-btn--ghost/);
    }
    await gotoRoute(page, origin, "stats");
    await expect(page.locator("#stats-refresh")).toHaveClass(/evu-btn--ghost/);
    await gotoRoute(page, origin, "logs");
    await expect(page.locator("#logs-refresh")).toHaveClass(/evu-btn--ghost/);
    // Polling covers Topology.
    await gotoRoute(page, origin, "topology");
    await expect(page.locator("#topology-refresh")).toHaveCount(0);
  });

  test("confirm dialogs use the danger style, peer names and outcome labels", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const peerName = (await page.locator("#routes-table-wrap .route-target-name").first().textContent())!.trim();
    await page.locator("#routes-table-wrap .route-target-name").first().locator("xpath=ancestor::tr").locator("[data-route-del]").click();
    const dialog = page.locator("#confirm-modal");
    await expect(dialog).toContainText(`will stop forwarding to ${peerName}`);
    await expect(dialog).not.toContainText("→");
    const ok = page.locator("#confirm-modal-ok");
    await expect(ok).toHaveText("Remove route");
    await expect(ok).toHaveClass(/evu-btn--danger/);
    await page.locator("#confirm-modal-cancel").click();
  });

  test("Overview and Stats read in plain language", async ({ page }) => {
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await patchApi(page, "/v1/events*", () => ({
      events: [
        { ts: twoHoursAgo, event: "reload_ok" },
        { ts: twoHoursAgo, event: "config_put_ok" },
      ],
    }));
    await gotoRoute(page, origin, "overview");
    const summary = page.locator(".overview-activity-pane").first();
    await expect(summary).toContainText("Applied config · 2h ago");
    await expect(summary.locator("time")).toHaveAttribute("title", /\d{4}/);
    await expect(page.locator("#overview-events-list")).toContainText("Saved config");
    await expect(page.locator("#overview-events-list")).not.toContainText("config_put_ok");
    await expect(page.locator("#page-overview")).not.toContainText(twoHoursAgo);

    await patchApi(page, "/v1/stats", (st) => ({
      ...st,
      wireguard_peers: [
        { public_key: "abc", endpoint: "", latest_handshake_unix: Math.floor(Date.now() / 1000) - 300, transfer_rx: 5546, transfer_tx: 0 },
      ],
    }));
    await gotoRoute(page, origin, "stats");
    const row = page.locator("#stats-wg-wrap tbody tr").first();
    await expect(row).toContainText("5.4 KiB / 0 B");
    await expect(row).toContainText("5m ago");
  });

  test("relative times turn absolute after a week", async ({ page }) => {
    await gotoRoute(page, origin, "overview");
    const out = await page.evaluate(async () => {
      const f = await import("/static/js/core/format.js" as string);
      const now = Date.parse("2026-06-15T12:00:00Z");
      const ago = (ms: number) => f.formatRelativeTime(new Date(now - ms), now);
      const DAY = 24 * 60 * 60 * 1000;
      return {
        now: ago(5_000),
        sixDays: ago(6 * DAY),
        week: ago(7 * DAY),
        bytes: [0, 1023, 1024, 5546, 1024 ** 3].map(f.formatBytes),
        missing: f.formatBytes(undefined),
      };
    });
    expect(out.now).toBe("just now");
    expect(out.sixDays).toBe("6d ago");
    expect(out.week).toMatch(/2026/);
    expect(out.bytes).toEqual(["0 B", "1,023 B", "1 KiB", "5.4 KiB", "1 GiB"]);
    expect(out.missing).toBe("—");
  });

  test("the filter lives in the Peers and Routes toolbars only", async ({ page }) => {
    await gotoRoute(page, origin, "stats");
    await expect(page.locator(".evu-app-header__meta input")).toHaveCount(0);
    await page.keyboard.press("/");
    await expect(page.locator(".table-filter:focus")).toHaveCount(0);

    await gotoRoute(page, origin, "routes");
    await page.keyboard.press("/");
    await expect(page.locator("#routes-filter")).toBeFocused();
    await page.keyboard.type("no-such-route");
    await expect(page.locator("#routes-table-wrap tbody tr:not(.is-filter-hidden)")).toHaveCount(0);
  });

  test("Inbound shows port sets without the braces", async ({ page }) => {
    await patchApi(page, "/v1/config", (cfg) => ({
      ...cfg,
      input_allows: [{ proto: "tcp", dport: "{ 80, 443 }", note: "web" }],
    }));
    await gotoRoute(page, origin, "inbound");
    await expect(page.locator("#inbound-table-wrap tbody tr").first().locator("td").nth(1)).toHaveText("80, 443");
  });

  test("peer public keys take one line and copy in full", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
    const key = "A".repeat(43) + "=";
    await patchApi(page, "/v1/config", (cfg) => {
      cfg.peers[0].public_key = key;
      return cfg;
    });
    await gotoRoute(page, origin, "peers");
    const cell = page.locator("#peers-table-wrap .public-key-cell").first();
    await expect(cell.locator(".public-key-text")).toContainText("…");
    await expect(cell.locator(".public-key-text")).toHaveCSS("white-space", "nowrap");
    await cell.locator("button").click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  });

  test("the tab title names the page and counts unapplied changes", async ({ page }) => {
    await patchApi(page, "/v1/pending", (p) => ({
      ...p,
      pending: true,
      nftables_baseline: "a\nkeep\nb\nkeep\nc",
      nftables: "A\nkeep\nB\nkeep\nC",
    }));
    await gotoRoute(page, origin, "routes");
    await expect(page).toHaveTitle("Routes · EvuProxy (3)");
    await page.unroute("**/api/v1/pending");
    await patchApi(page, "/v1/pending", (p) => ({ ...p, pending: false }));
    await gotoRoute(page, origin, "inbound");
    await expect(page).toHaveTitle("Inbound access · EvuProxy");
  });

  test("the favicon is served", async ({ request, page }) => {
    const ico = await request.get(origin + "/favicon.ico");
    expect(ico.status()).toBe(200);
    expect(ico.headers()["content-type"]).toContain("image/svg+xml");
    await gotoRoute(page, origin, "overview");
    const href = await page.locator('link[rel="icon"]').getAttribute("href");
    expect((await request.get(origin + href!)).status()).toBe(200);
  });

  test("a modal animates when clicked open and exits faster", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-add").click();
    expect(await modalTransitionCount(page, "#route-modal")).toBeGreaterThan(0);
    const enter = await page.evaluate(() => getComputedStyle(document.querySelector("#route-modal")!).transitionDuration);
    await expect(page.locator("#route-modal .modal-panel")).toHaveCSS("transform", "none");
    await page.locator("#route-cancel").click();
    const exit = await page.evaluate(() => getComputedStyle(document.querySelector("#route-modal")!).transitionDuration);
    expect(parseFloat(exit)).toBeLessThan(parseFloat(enter));
    await expect(page.locator("#route-modal")).toBeHidden();
  });

  test("a modal opened and closed from the keyboard does not animate", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-add").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#route-modal")).toHaveClass(/modal--instant/);
    expect(await modalTransitionCount(page, "#route-modal")).toBe(0);
    await page.keyboard.press("Escape");
    expect(await page.locator("#route-modal").isVisible()).toBe(false);
  });

  /** The fade lasts 150ms, too short to poll for, so the page records it happening. */
  function watchForLeavingRow(page: Page): Promise<void> {
    return page.evaluate(() => {
      new MutationObserver(() => {
        if (document.querySelector("#routes-table-wrap tr.is-row-leaving")) (window as any).sawLeavingRow = true;
      }).observe(document.querySelector("#routes-table-wrap")!, { subtree: true, attributes: true, attributeFilter: ["class"] });
    });
  }

  test("a removed row fades when clicked, and not from the keyboard", async ({ page, request }) => {
    const headers = { Authorization: "Bearer " + token() };
    const snapshot = await (await request.get(origin + "/api/v1/config", { headers })).json();
    try {
      await gotoRoute(page, origin, "routes");
      await watchForLeavingRow(page);
      const before = await page.locator("#routes-table-wrap tbody tr").count();
      expect(before).toBeGreaterThan(1);

      await page.locator("#routes-table-wrap [data-route-del]").first().click();
      await page.locator("#confirm-modal-ok").click();
      await expect(page.locator("#routes-table-wrap tbody tr")).toHaveCount(before - 1);
      expect(await page.evaluate(() => (window as any).sawLeavingRow)).toBe(true);

      await page.evaluate(() => { (window as any).sawLeavingRow = false; });
      await page.locator("#routes-table-wrap [data-route-del]").first().focus();
      await page.keyboard.press("Enter");
      await page.locator("#confirm-modal-ok").focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#routes-table-wrap tbody tr")).toHaveCount(before - 2);
      expect(await page.evaluate(() => (window as any).sawLeavingRow)).toBe(false);
    } finally {
      await request.put(origin + "/api/v1/config", { headers: { ...headers, "Content-Type": "application/json" }, data: snapshot });
    }
  });
});
