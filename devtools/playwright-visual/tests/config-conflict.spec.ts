/**
 * A stale tab must not revert a change saved elsewhere (lost update): saves carry the
 * config revision, and on a 409 the UI reapplies the single edit to fresh config.
 *
 * Each test loads a page, then changes the config through the API behind its back,
 * which is what another tab or the CLI would do.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";
const configUrl = origin + "/api/v1/config";
const auth = () => ({ Authorization: "Bearer " + token() });

async function getConfig(request: APIRequestContext) {
  const res = await request.get(configUrl, { headers: auth() });
  expect(res.ok()).toBeTruthy();
  return { cfg: await res.json(), etag: res.headers()["etag"] };
}

/** No If-Match: an unconditional save, like automation or the test's own cleanup. */
async function putConfig(request: APIRequestContext, cfg: unknown) {
  const res = await request.put(configUrl, {
    headers: { ...auth(), "Content-Type": "application/json" },
    data: cfg,
  });
  expect(res.ok()).toBeTruthy();
}

/** Edits the saved config as another client would, without telling the open page. */
async function saveElsewhere(request: APIRequestContext, edit: (cfg: any) => void) {
  const { cfg } = await getConfig(request);
  edit(cfg);
  await putConfig(request, cfg);
}

function countConfigPuts(page: Page) {
  const statuses: number[] = [];
  page.on("response", (res) => {
    if (res.url().endsWith("/api/v1/config") && res.request().method() === "PUT") statuses.push(res.status());
  });
  return statuses;
}

test.describe("conflicting config saves", () => {
  let snapshot: unknown;

  test.beforeEach(async ({ page, request }) => {
    snapshot = (await getConfig(request)).cfg;
    await seed(page, { scheme: "light" });
  });

  test.afterEach(async ({ request }) => {
    await putConfig(request, snapshot);
  });

  test("API: stale If-Match gets 409 and writes nothing, missing If-Match still saves", async ({ request }) => {
    const { cfg, etag } = await getConfig(request);
    expect(etag).toMatch(/^".+"$/);

    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
    });
    const stale = await request.put(configUrl, {
      headers: { ...auth(), "Content-Type": "application/json", "If-Match": etag },
      data: cfg,
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error_code).toBe("config_revision_mismatch");
    expect((await getConfig(request)).cfg.peers[0].name).toBe("saved-elsewhere");

    await putConfig(request, cfg);
    expect((await getConfig(request)).cfg.peers[0].name).toBe(cfg.peers[0].name);
  });

  test("stale route toggle keeps a peer rename saved elsewhere", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    const toggle = page.locator("#routes-table-wrap input[data-route-disabled]").first();
    await expect(toggle).toBeAttached();
    const wasDisabled = !(await toggle.isChecked());

    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
    });
    const puts = countConfigPuts(page);
    await page.locator("#routes-table-wrap .evu-switch").first().click();

    await expect.poll(() => puts).toEqual([409, 200]);
    const { cfg } = await getConfig(request);
    expect(cfg.peers[0].name).toBe("saved-elsewhere");
    expect(!!cfg.forwarding.routes[0].disabled).toBe(!wasDisabled);
    await expect(page.locator("#routes-msg")).not.toHaveClass(/err/);
  });

  test("stale route Remove keeps a peer rename and removes the right row after reordering", async ({ page, request }) => {
    const before = (await getConfig(request)).cfg;
    expect(before.forwarding.routes.length).toBeGreaterThan(1);
    const target = before.forwarding.routes[0];

    await gotoRoute(page, origin, "routes");
    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
      c.forwarding.routes.reverse();
    });
    await page.locator("#routes-table-wrap [data-route-del]").first().click();
    await page.locator("#confirm-modal-ok").click();
    await expect(page.locator("#routes-msg")).toContainText(/removed/i);

    const { cfg } = await getConfig(request);
    expect(cfg.peers[0].name).toBe("saved-elsewhere");
    expect(cfg.forwarding.routes).toHaveLength(before.forwarding.routes.length - 1);
    expect(cfg.forwarding.routes).not.toContainEqual(target);
  });

  test("toggling a route removed elsewhere explains itself and changes nothing", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await saveElsewhere(request, (c) => {
      c.forwarding.routes.shift();
    });
    const expected = (await getConfig(request)).cfg;

    await page.locator("#routes-table-wrap .evu-switch").first().click();

    await expect(page.locator("#routes-msg")).toContainText(/changed or removed elsewhere/);
    await expect(page.locator("#routes-table-wrap tbody tr")).toHaveCount(expected.forwarding.routes.length);
    expect((await getConfig(request)).cfg).toEqual(expected);
  });

  test("editing a route changed elsewhere keeps the form open with the user's values", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await expect(page.locator("#route-modal")).toBeVisible();
    await page.locator("#route-f-ports").fill("4242");

    await saveElsewhere(request, (c) => {
      c.forwarding.routes[0].ports = ["5151"];
    });
    await page.locator("#route-save").click();

    await expect(page.locator("#route-editor-msg")).toContainText(/still in this form/);
    await expect(page.locator("#route-modal")).toBeVisible();
    await expect(page.locator("#route-f-ports")).toHaveValue("4242");
    expect((await getConfig(request)).cfg.forwarding.routes[0].ports).toEqual(["5151"]);
  });

  test("editing a route merges with an unrelated change saved elsewhere", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await page.locator("#route-f-ports").fill("4242");

    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
    });
    await page.locator("#route-save").click();

    await expect(page.locator("#route-modal")).toBeHidden();
    const { cfg } = await getConfig(request);
    expect(cfg.peers[0].name).toBe("saved-elsewhere");
    expect(cfg.forwarding.routes[0].ports).toEqual(["4242"]);
  });

  test("stale peer toggle survives a rename of that same peer", async ({ page, request }) => {
    await gotoRoute(page, origin, "peers");
    const wasDisabled = !!(await getConfig(request)).cfg.peers[0].disabled;
    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
      for (const r of c.forwarding.routes) r.disabled = true;
    });

    await page.locator("#peers-table-wrap .evu-switch").first().click();
    // The stale page may still see enabled routes on this peer and ask first.
    const dialogOk = page.locator("#confirm-modal-ok");
    if (await dialogOk.isVisible()) await dialogOk.click();

    await expect
      .poll(async () => !!(await getConfig(request)).cfg.peers[0].disabled)
      .toBe(!wasDisabled);
    expect((await getConfig(request)).cfg.peers[0].name).toBe("saved-elsewhere");
  });

  test("geoblocking save conflicts only when geoblocking itself changed elsewhere", async ({ page, request }) => {
    await gotoRoute(page, origin, "geoblocking");
    await saveElsewhere(request, (c) => {
      c.peers[0].name = "saved-elsewhere";
    });
    await page.locator("#geo-save").click();
    await expect(page.locator("#geo-msg")).toContainText(/^Saved/);
    expect((await getConfig(request)).cfg.peers[0].name).toBe("saved-elsewhere");

    await saveElsewhere(request, (c) => {
      c.geo.break_glass_cidrs = ["203.0.113.9/32"];
    });
    await page.locator("#geo-save").click();
    await expect(page.locator("#geo-msg")).toContainText(/changed elsewhere/);
    expect((await getConfig(request)).cfg.geo.break_glass_cidrs).toEqual(["203.0.113.9/32"]);

    await page.locator("#geo-save").click();
    await expect(page.locator("#geo-msg")).toContainText(/^Saved/);
  });
});
