/**
 * Draft edits act at once and offer Undo; riskier actions keep a specific confirmation.
 *
 * Undo is a reversal into fresh config, so these tests also change the config behind
 * the page's back and check that the change survives.
 */
import { expect, test, type APIRequestContext, type Locator, type Page } from "./fixtures";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const auth = () => ({ Authorization: "Bearer " + token() });

async function fetchConfig(request: APIRequestContext) {
  const res = await request.get(origin + "/api/v1/config", { headers: auth() });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function putConfig(request: APIRequestContext, cfg: unknown) {
  const res = await request.put(origin + "/api/v1/config", {
    headers: { ...auth(), "Content-Type": "application/json" },
    data: cfg,
  });
  expect(res.ok()).toBeTruthy();
}

async function saveElsewhere(request: APIRequestContext, edit: (cfg: any) => void) {
  const cfg = await fetchConfig(request);
  edit(cfg);
  await putConfig(request, cfg);
}

const toast = (page: Page) => page.locator("#toaster .evu-toast");
const undo = (page: Page) => toast(page).getByRole("button", { name: "Undo" });
const confirmDialog = (page: Page) => page.locator("#confirm-modal");
const switchTrack = (scope: Locator, input: string) => scope.locator(`label.evu-switch:has(${input})`).first();

/** A peer with a route, plus a second peer so the list does not empty. */
function withPeerAndRoute(cfg: any) {
  const host = "10.99.0.2";
  cfg.peers = [
    { name: "laptop", tunnel_ip: host + "/32", public_key: "a".repeat(43) + "=" },
    { name: "phone", tunnel_ip: "10.99.0.3/32", public_key: "b".repeat(43) + "=" },
  ];
  cfg.forwarding = cfg.forwarding || {};
  cfg.forwarding.routes = [
    { proto: "tcp", ports: ["8080"], target_ip: host },
    { proto: "tcp", ports: ["9090"], target_ip: "10.99.0.3" },
  ];
}

test.describe("draft edits act at once and offer Undo", () => {
  let snapshot: unknown;

  test.beforeEach(async ({ page, request }) => {
    snapshot = await fetchConfig(request);
    await saveElsewhere(request, withPeerAndRoute);
    await seed(page, { scheme: "light" });
    page.on("dialog", (d) => {
      throw new Error("native dialog opened: " + d.message());
    });
  });

  test.afterEach(async ({ request }) => {
    await putConfig(request, snapshot);
  });

  test("removing a peer saves at once and names the cascade; Undo restores both", async ({ page, request }) => {
    const before = await fetchConfig(request);
    await gotoRoute(page, origin, "peers");

    await page.locator("#peers-table-wrap [data-peer-del]").first().click();

    await expect(toast(page)).toContainText("Removed laptop and disabled 1 route.");
    await expect(confirmDialog(page)).toBeHidden();
    const saved = await fetchConfig(request);
    expect(saved.peers.map((p: any) => p.name)).toEqual(["phone"]);
    expect(saved.forwarding.routes[0].disabled).toBe(true);

    await undo(page).click();

    await expect(toast(page)).toContainText("Restored laptop and its routes.");
    const restored = await fetchConfig(request);
    expect(restored.peers).toEqual(before.peers);
    // Enabled is enabled, whether or not the row spells out `disabled: false`.
    const enabledRoutes = (routes: any[]) => routes.map((r) => ({ ...r, disabled: !!r.disabled }));
    expect(enabledRoutes(restored.forwarding.routes)).toEqual(enabledRoutes(before.forwarding.routes));
  });

  test("Undo goes into fresh config and keeps what was saved since", async ({ page, request }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#peers-table-wrap [data-peer-del]").first().click();
    await expect(undo(page)).toBeVisible();

    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
    });
    await undo(page).click();
    await expect(toast(page)).toContainText("Restored laptop");

    const names = (await fetchConfig(request)).peers.map((p: any) => p.name);
    expect(names).toEqual(["laptop", "saved-elsewhere"]);
  });

  test("Undo says which cascaded route it could not bring back", async ({ page, request }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#peers-table-wrap [data-peer-del]").first().click();
    await expect(undo(page)).toBeVisible();

    await saveElsewhere(request, (c) => {
      c.forwarding.routes.shift();
    });
    await undo(page).click();

    await expect(toast(page)).toContainText("1 route changed elsewhere and stayed disabled");
    expect((await fetchConfig(request)).peers.map((p: any) => p.name)).toEqual(["laptop", "phone"]);
  });

  test("a failed Undo stays up and can be tried again", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-table-wrap [data-route-del]").first().click();
    await expect(undo(page)).toBeVisible();

    await page.route("**/api/v1/config", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' })
        : route.fallback()
    );
    await undo(page).click();
    await expect(toast(page)).toContainText("Could not undo: disk full");
    await expect(toast(page)).toHaveAttribute("data-error", "");

    await page.unroute("**/api/v1/config");
    await undo(page).click();
    await expect(toast(page)).toContainText("Restored route");
    expect((await fetchConfig(request)).forwarding.routes).toHaveLength(2);
  });

  test("a double-click on Undo restores once and reports no false error", async ({ page, request }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#peers-table-wrap [data-peer-del]").first().click();
    await expect(undo(page)).toBeVisible();

    const puts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "PUT" && r.url().endsWith("/api/v1/config")) puts.push(r.url());
    });
    await undo(page).dblclick();

    await expect(toast(page)).toContainText("Restored laptop and its routes.");
    await page.waitForTimeout(500);
    await expect(toast(page)).not.toHaveAttribute("data-error", "");
    expect(puts).toHaveLength(1);
    expect((await fetchConfig(request)).peers.map((p: any) => p.name)).toEqual(["laptop", "phone"]);
  });

  test("Undo restores a removed route next to a twin that only looks the same", async ({ page, request }) => {
    const live = { proto: "tcp", ports: ["8080"], target_ip: "10.99.0.2" };
    const twin = { ...live, disabled: true, source_allow_cidrs: ["192.0.2.0/24"] };
    await saveElsewhere(request, (c) => {
      c.forwarding.routes = [live, twin];
    });
    await gotoRoute(page, origin, "routes");
    const wrap = page.locator("#routes-table-wrap");

    await wrap.locator('[data-route-del="0"]').click();
    await expect(undo(page)).toBeVisible();
    await undo(page).click();

    await expect(toast(page)).toContainText("Restored route");
    const routes = (await fetchConfig(request)).forwarding.routes;
    expect(routes).toHaveLength(2);
    expect(routes[0]).toMatchObject(live);
    expect(!!routes[0].disabled).toBe(false);
    expect(routes[1]).toMatchObject(twin);
    await expect(wrap.locator('tr[data-row="0"]')).toBeFocused();
  });

  test("Undo restores a removed inbound rule next to its disabled twin", async ({ page, request }) => {
    const live = { proto: "tcp", dport: "22", note: "ssh" };
    const twin = { ...live, disabled: true };
    await saveElsewhere(request, (c) => {
      c.input_allows = [live, twin];
    });
    await gotoRoute(page, origin, "inbound");
    const wrap = page.locator("#inbound-table-wrap");

    await wrap.locator('[data-inbound-del="0"]').click();
    await expect(undo(page)).toBeVisible();
    await undo(page).click();

    await expect(toast(page)).toContainText("Restored inbound rule");
    const rules = (await fetchConfig(request)).input_allows;
    expect(rules).toHaveLength(2);
    expect(!!rules[0].disabled).toBe(false);
    expect(rules[1].disabled).toBe(true);
    await expect(wrap.locator('tr[data-row="0"]')).toBeFocused();
  });

  test("Undo adds no duplicate when the same row was saved back elsewhere", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    const removed = (await fetchConfig(request)).forwarding.routes[0];
    await page.locator("#routes-table-wrap [data-route-del]").first().click();
    await expect(undo(page)).toBeVisible();

    await saveElsewhere(request, (c) => {
      c.forwarding.routes.unshift(removed);
    });
    await undo(page).click();

    await expect(toast(page)).toContainText("Restored route");
    expect((await fetchConfig(request)).forwarding.routes).toHaveLength(2);
  });

  test("Undo of a route removed from another page refreshes the page on screen", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-table-wrap [data-route-del]").first().click();
    await expect(undo(page)).toBeVisible();

    await page.locator('.nav-link[data-route="pending"]').click();
    await expect(page.locator("#page-pending")).toBeVisible();
    await undo(page).click();

    await expect(toast(page)).toContainText("Restored route");
    await expect(page.locator("#page-pending")).toBeVisible();
    expect((await fetchConfig(request)).forwarding.routes).toHaveLength(2);
  });

  test("Remove moves focus to the next row, or to Add on an empty list", async ({ page, request }) => {
    await saveElsewhere(request, (c) => {
      c.input_allows = [
        { proto: "tcp", dport: "22", note: "ssh" },
        { proto: "tcp", dport: "443", note: "https" },
      ];
    });
    await gotoRoute(page, origin, "inbound");
    const wrap = page.locator("#inbound-table-wrap");

    await wrap.locator("[data-inbound-del]").first().focus();
    await page.keyboard.press("Enter");
    await expect(toast(page)).toContainText("Removed inbound rule tcp 22 (ssh).");
    await expect(wrap.locator('tr[data-row="0"]')).toBeFocused();
    await expect(wrap.locator('tr[data-row="0"]')).toContainText("443");

    // Enter on the focused row does nothing: a held key cannot walk down the list.
    await page.keyboard.press("Enter");
    await expect(wrap.locator("tbody tr[data-row]")).toHaveCount(1);

    await wrap.locator("[data-inbound-del]").first().focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#inbound-empty-add")).toBeFocused();

    await undo(page).click();
    await expect(wrap.locator('tr[data-row="0"]')).toBeFocused();
    await expect(wrap.locator('tr[data-row="0"]')).toContainText("443");
  });

  test("a double-click removes one row, not the row that slid under the pointer", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-table-wrap [data-route-del]").first().dblclick();
    await expect(toast(page)).toContainText("Removed route");
    await page.waitForTimeout(300);
    expect((await fetchConfig(request)).forwarding.routes).toHaveLength(1);
  });

  test("a route switch offers Undo and returns focus to the switch", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    const wrap = page.locator("#routes-table-wrap");
    await switchTrack(wrap, "input[data-route-disabled]").click();
    await expect(toast(page)).toContainText("Route disabled");
    expect((await fetchConfig(request)).forwarding.routes[0].disabled).toBe(true);

    await undo(page).click();
    await expect(toast(page)).toContainText("Route enabled");
    expect(!!(await fetchConfig(request)).forwarding.routes[0].disabled).toBe(false);
    await expect(wrap.locator('input[data-route-disabled="0"]')).toBeFocused();
  });

  test("disabling a peer disables its routes as one action, with no dialog", async ({ page, request }) => {
    await gotoRoute(page, origin, "peers");
    await switchTrack(page.locator("#peers-table-wrap"), "input[data-peer-disabled]").click();

    await expect(toast(page)).toContainText("Disabled laptop and 1 route.");
    await expect(confirmDialog(page)).toBeHidden();
    let cfg = await fetchConfig(request);
    expect(cfg.peers[0].disabled).toBe(true);
    expect(cfg.forwarding.routes[0].disabled).toBe(true);

    await undo(page).click();
    await expect(toast(page)).toContainText("Enabled laptop and its routes.");
    cfg = await fetchConfig(request);
    expect(!!cfg.peers[0].disabled).toBe(false);
    expect(!!cfg.forwarding.routes[0].disabled).toBe(false);
  });

  test("maintenance mode has no native confirm and offers Undo", async ({ page, request }) => {
    await gotoRoute(page, origin, "overview");
    const toggle = page.locator("#overview-maintenance-toggle");
    await expect(toggle).not.toBeChecked();

    await page.locator("label:has(#overview-maintenance-toggle)").click();

    await expect(toast(page)).toContainText("Public port forwards stop when you Apply");
    expect((await fetchConfig(request)).forwarding.maintenance_mode).toBe(true);

    await undo(page).click();
    await expect(toast(page)).toContainText("Maintenance mode off");
    await expect(toggle).not.toBeChecked();
    expect(!!(await fetchConfig(request)).forwarding.maintenance_mode).toBe(false);
  });
});

test.describe("riskier actions keep a specific confirmation", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("Discard names how many changes it drops", async ({ page }) => {
    await page.route("**/api/v1/pending", async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      await route.fulfill({
        response: res,
        json: { ...body, pending: true, discard_available: true, discard_change_count: 3 },
      });
    });
    await gotoRoute(page, origin, "pending");

    await page.locator("#pending-discard").click();

    await expect(confirmDialog(page)).toContainText("Discard 3 changes?");
    await expect(page.locator("#confirm-modal-ok")).toHaveText("Discard 3 changes");
    await page.locator("#confirm-modal-cancel").click();
    await expect(confirmDialog(page)).toBeHidden();
  });

  test("Restore backup names the archive and its date and offers a backup first", async ({ page, request }) => {
    await gotoRoute(page, origin, "settings");
    await page.getByRole("tab", { name: /Notes/ }).click();
    await page.locator("#restore-path-input").fill("/var/backups/evuproxy-config.tgz");

    await page.locator("#btn-restore-run").click();

    await expect(confirmDialog(page)).toContainText("Restore evuproxy-config.tgz?");
    await expect(confirmDialog(page)).toContainText("/var/backups/evuproxy-config.tgz, dated ");

    const extra = page.locator("#confirm-modal-extra");
    await extra.click();
    const status = page.locator("#confirm-modal-status");
    await expect(status).toContainText(/Backup created: \/var\/backups\/evuproxy-pre-restore-\d{8}-\d{6}\.tgz/);
    await expect(page.locator("#confirm-modal-ok")).toBeFocused();

    const path = ((await status.textContent()) || "").replace("Backup created: ", "");
    const info = await request.get(origin + "/api/v1/backup/info?path=" + encodeURIComponent(path), { headers: auth() });
    expect(info.ok()).toBeTruthy();

    await page.locator("#confirm-modal-cancel").click();
    await expect(confirmDialog(page)).toBeHidden();
  });

  test("Restore stops at a missing archive instead of asking", async ({ page }) => {
    await gotoRoute(page, origin, "settings");
    await page.getByRole("tab", { name: /Notes/ }).click();
    await page.locator("#restore-path-input").fill("/var/backups/no-such-archive.tgz");

    await page.locator("#btn-restore-run").click();

    await expect(page.locator("#backup-restore-msg")).toContainText("No archive at /var/backups/no-such-archive.tgz");
    await expect(confirmDialog(page)).toBeHidden();
  });
});
