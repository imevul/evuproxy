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
    await expect(page.locator("#toaster")).toContainText(/removed/i);

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
    await expect(page.locator("#routes-table-wrap tr.row-error")).toHaveCount(0);
    await expect(page.locator("#routes-table-wrap tbody tr")).toHaveCount(expected.forwarding.routes.length);
    expect((await getConfig(request)).cfg).toEqual(expected);
  });

  for (const row of [
    { page: "routes", input: "input[data-route-disabled]", msg: "#routes-msg", drop: (c: any) => c.forwarding.routes.pop() },
    { page: "peers", input: "input[data-peer-disabled]", msg: "#peers-msg", drop: (c: any) => c.peers.pop() },
    { page: "inbound", input: "input[data-inbound-disabled]", msg: "#inbound-msg", drop: (c: any) => c.input_allows.pop() },
  ]) {
    test(`toggling the last ${row.page} row removed elsewhere still reports it`, async ({ page, request }) => {
      await gotoRoute(page, origin, row.page);
      const wrap = page.locator(`#${row.page}-table-wrap`);
      await expect(wrap.locator(row.input).first()).toBeAttached();
      await saveElsewhere(request, (c) => {
        row.drop(c);
      });
      const expected = (await getConfig(request)).cfg;

      await wrap.locator(`label.evu-switch:has(${row.input})`).last().click();

      await expect(page.locator(row.msg)).toContainText(/changed or removed elsewhere/);
      await expect(page.locator(row.msg)).toHaveClass(/err/);
      await expect(wrap.locator("tr.row-error")).toHaveCount(0);
      await expect(page.locator("#toaster .evu-toast")).toHaveCount(0);
      expect((await getConfig(request)).cfg).toEqual(expected);
      await expect(page.locator(`${row.input}:focus`)).toHaveCount(1);
    });
  }

  test("a save failing after its retry moved the rows reports under the row that moved", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    const target = (await getConfig(request)).cfg.forwarding.routes[0];
    await saveElsewhere(request, (c) => {
      c.forwarding.routes.reverse();
    });
    // The first PUT reaches the server and gets its 409; the retry then fails.
    let puts = 0;
    await page.route("**/api/v1/config", (route) => {
      if (route.request().method() !== "PUT" || ++puts === 1) return route.fallback();
      return route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' });
    });

    await page.locator("#routes-table-wrap .evu-switch").first().click();

    const err = page.locator("#routes-table-wrap tr.row-error");
    await expect(err).toHaveText(/disk full/);
    await expect(page.locator("#routes-table-wrap tbody tr:has(+ tr.row-error)")).toContainText(target.ports[0]);
    await expect(page.locator("#routes-msg")).toHaveText("");
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
    const bar = page.locator("#page-geoblocking .save-bar");
    const save = bar.getByRole("button", { name: "Save" });
    // The bar exists only while dirty, so each save needs an edit: flip the list mode.
    const flipMode = () => page.locator("#page-geoblocking .geo-mode-btn:not(.is-active)").click();

    await flipMode();
    await save.click();
    await expect(page.locator("#toaster")).toContainText(/Geoblocking saved/);
    expect((await getConfig(request)).cfg.peers[0].name).toBe("saved-elsewhere");

    await saveElsewhere(request, (c) => {
      c.geo.break_glass_cidrs = ["203.0.113.9/32"];
    });
    await flipMode();
    await save.click();
    await expect(bar.locator(".save-bar__error")).toContainText(/changed elsewhere/);
    expect((await getConfig(request)).cfg.geo.break_glass_cidrs).toEqual(["203.0.113.9/32"]);

    await save.click();
    await expect(page.locator("#toaster")).toContainText(/Geoblocking saved/);
    await expect(bar).toBeHidden();
  });

  test("a switch flipped elsewhere is no conflict for the form", async ({ page, request }) => {
    await gotoRoute(page, origin, "geoblocking");
    const wasInbound = !!(await getConfig(request)).cfg.geo.apply_to_input_allows;
    await page.locator("#page-geoblocking .geo-mode-btn:not(.is-active)").click();
    await saveElsewhere(request, (c) => {
      c.geo.apply_to_input_allows = !wasInbound;
    });

    await page.locator("#page-geoblocking .save-bar").getByRole("button", { name: "Save" }).click();

    await expect(page.locator("#toaster")).toContainText(/Geoblocking saved/);
    expect(!!(await getConfig(request)).cfg.geo.apply_to_input_allows).toBe(!wasInbound);
  });
});
