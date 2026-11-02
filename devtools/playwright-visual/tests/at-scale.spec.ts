/**
 * Lists and topology with a large config: 40 peers and 31 routes, the size that was
 * unusable. The config goes through the mock's real PUT so saves from a sorted table
 * can be checked against what actually landed.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { gotoRoute, largeConfig, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const configUrl = origin + "/api/v1/config";
const auth = () => ({ Authorization: "Bearer " + token() });

async function getConfig(request: APIRequestContext) {
  const res = await request.get(configUrl, { headers: auth() });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function putConfig(request: APIRequestContext, cfg: unknown) {
  const res = await request.put(configUrl, {
    headers: { ...auth(), "Content-Type": "application/json" },
    data: cfg,
  });
  expect(res.ok()).toBeTruthy();
}

const routeRows = (page: Page) => page.locator("#routes-table-wrap tbody tr:not(.row-error)");
const sortButton = (page: Page, wrap: string, label: string) =>
  page.locator(`#${wrap} thead`).getByRole("button", { name: label, exact: true });

async function columnText(page: Page, wrap: string, nth: number): Promise<string[]> {
  return page.locator(`#${wrap} tbody tr:not(.row-error) td:nth-child(${nth})`).allInnerTexts();
}

test.describe("at scale", () => {
  let snapshot: unknown;

  test.beforeEach(async ({ page, request }) => {
    snapshot = await getConfig(request);
    await putConfig(request, largeConfig(snapshot));
    await seed(page, { scheme: "light" });
  });

  test.afterEach(async ({ request }) => {
    await putConfig(request, snapshot);
  });

  for (const [route, wrap] of [
    ["routes", "routes-table-wrap"],
    ["peers", "peers-table-wrap"],
    ["inbound", "inbound-table-wrap"],
  ] as const) {
    test(`${route}: the header stays at the top while the rows scroll`, async ({ page }) => {
      await gotoRoute(page, origin, route);
      const scroller = page.locator(`#${wrap}`);
      const header = page.locator(`#${wrap} thead th`).first();
      await expect(header).toBeVisible();
      const before = await header.boundingBox();

      const scrolled = await scroller.evaluate((el) => {
        el.scrollTop = 400;
        return el.scrollTop;
      });
      expect(scrolled, "the list should overflow and scroll inside its wrap").toBeGreaterThan(0);

      const after = await header.boundingBox();
      expect(after!.y).toBeCloseTo(before!.y, 0);
      // Stuck for real: the header is what is painted there, not a row scrolled under it.
      const onTop = await header.evaluate((th) => {
        const r = th.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && th.contains(hit);
      });
      expect(onTop).toBe(true);
    });
  }

  test("a tabbed-to row does not land under the sticky header", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const scroller = page.locator("#routes-table-wrap");
    await scroller.evaluate((el) => {
      el.scrollTop = 600;
    });
    const header = await page.locator("#routes-table-wrap thead").boundingBox();
    await page.locator("#routes-table-wrap [data-route-edit]").nth(2).focus();
    const focused = await page.locator("#routes-table-wrap [data-route-edit]").nth(2).boundingBox();
    expect(focused!.y).toBeGreaterThanOrEqual(header!.y + header!.height - 1);
  });

  test("sorting cycles ascending, descending, then back to config order", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const configOrder = await columnText(page, "routes-table-wrap", 3);
    const button = sortButton(page, "routes-table-wrap", "Ports");
    const th = page.locator("#routes-table-wrap thead th", { hasText: "Ports" });
    await expect(th).not.toHaveAttribute("aria-sort", /.*/);

    await button.click();
    await expect(th).toHaveAttribute("aria-sort", "ascending");
    const asc = await columnText(page, "routes-table-wrap", 3);
    expect(asc).toEqual([...asc].sort((a, b) => +a - +b));
    expect(asc[0]).toBe("3000");

    await button.click();
    await expect(th).toHaveAttribute("aria-sort", "descending");
    expect(await columnText(page, "routes-table-wrap", 3)).toEqual([...asc].reverse());

    await button.click();
    await expect(th).not.toHaveAttribute("aria-sort", /.*/);
    expect(await columnText(page, "routes-table-wrap", 3)).toEqual(configOrder);
  });

  test("sort buttons work from the keyboard and keep focus through the redraw", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const button = sortButton(page, "routes-table-wrap", "Proto");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#routes-table-wrap thead th", { hasText: "Proto" })).toHaveAttribute("aria-sort", "ascending");
    await expect(button).toBeFocused();
  });

  test("unnamed routes sort last whichever way the Name column is sorted", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const button = sortButton(page, "routes-table-wrap", "Name");
    for (const first of ["service-01", "service-31"]) {
      await button.click();
      const names = await columnText(page, "routes-table-wrap", 1);
      expect(names[0]).toBe(first);
      expect(names.at(-1)).toBe("—");
      expect(names.indexOf("—")).toBe(11);
    }
  });

  test("a row in a sorted table still acts on its own route", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await sortButton(page, "routes-table-wrap", "Ports").click();
    const row = routeRows(page).first();
    await expect(row.locator("td").nth(2)).toHaveText("3000");

    await row.locator(".evu-switch").click();
    await expect(routeRows(page).first().locator("input[data-route-disabled]")).not.toBeChecked();

    const routes = (await getConfig(request)).forwarding.routes;
    const disabled = routes.filter((r: any) => r.disabled);
    expect(disabled.map((r: any) => r.ports[0])).toEqual(["3000"]);
    // The stored order is config order, not the order on screen.
    expect(routes[0].ports[0]).toBe("30000");
  });

  test("removing from a sorted table focuses the next row as drawn, and Undo brings it back", async ({ page, request }) => {
    await gotoRoute(page, origin, "routes");
    await sortButton(page, "routes-table-wrap", "Ports").click();
    const ports = await columnText(page, "routes-table-wrap", 3);
    const removedPort = ports[5];
    const nextPort = ports[6];

    await routeRows(page).nth(5).locator("[data-route-del]").click();
    await expect(routeRows(page)).toHaveCount(30);
    await expect(page.locator("#routes-table-wrap tbody tr:focus td").nth(2)).toHaveText(nextPort);
    let saved = (await getConfig(request)).forwarding.routes;
    expect(saved.map((r: any) => r.ports[0])).not.toContain(removedPort);

    await page.locator("#toaster").getByRole("button", { name: "Undo" }).click();
    await expect(routeRows(page)).toHaveCount(31);
    expect(await columnText(page, "routes-table-wrap", 3)).toEqual(ports);
    saved = (await getConfig(request)).forwarding.routes;
    expect(saved.map((r: any) => r.ports[0])).toContain(removedPort);
  });

  test("the toast for a removed route leads with its name", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await routeRows(page).first().locator("[data-route-del]").click();
    await expect(page.locator("#toaster .evu-toast")).toContainText("Removed route service-31 (tcp 30000 to peer-01)");
  });

  test("the sort and the scroll position survive a save", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await sortButton(page, "routes-table-wrap", "Ports").click();
    const scroller = page.locator("#routes-table-wrap");
    await scroller.evaluate((el) => {
      el.scrollTop = 300;
    });
    const row = routeRows(page).nth(12);
    const port = await row.locator("td").nth(2).innerText();
    await row.locator(".evu-switch").click();
    await expect(routeRows(page).nth(12).locator("input[data-route-disabled]")).not.toBeChecked();
    await expect(routeRows(page).nth(12).locator("td").nth(2)).toHaveText(port);
    expect(await scroller.evaluate((el) => el.scrollTop)).toBe(300);
  });

  test("peers sort by name, and a ping poll keeps the order", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    const button = sortButton(page, "peers-table-wrap", "Name");
    await button.click();
    await button.click();
    await expect(page.locator("#peers-table-wrap tbody tr td").first()).toHaveText("peer-40");
  });

  test.describe("topology", () => {
    const toggles = (page: Page) => page.locator("#topology-svg [data-topo-toggle]");
    const routeCards = (page: Page) => page.locator("#topology-svg .topology-node--route");

    test("starts grouped by peer and collapsed, at a readable size", async ({ page }) => {
      await gotoRoute(page, origin, "topology");
      await expect(toggles(page)).toHaveCount(10);
      await expect(routeCards(page)).toHaveCount(10);
      await expect(page.locator("#topology-scale-summary")).toHaveText("31 routes on 10 peer(s)");
      const card = await page.locator("#topology-svg .topology-node--peer").first().boundingBox();
      // Drawn at 58 units; the sliver this replaces was a fraction of that.
      expect(card!.height).toBeGreaterThanOrEqual(58);
    });

    test("Center returns to the readable level, not a fit of the whole graph", async ({ page }) => {
      await gotoRoute(page, origin, "topology");
      await page.locator("#topology-expand-all").click();
      await expect(routeCards(page)).toHaveCount(31);
      const graph = page.locator("#topology-svg");
      await graph.hover();
      await page.mouse.wheel(0, 500);
      await page.locator("#topology-center").click();
      const card = await page.locator("#topology-svg .topology-node--peer").first().boundingBox();
      const box = await graph.boundingBox();
      expect(card!.height).toBeGreaterThanOrEqual(58);
      expect(card!.y).toBeGreaterThanOrEqual(box!.y);
      expect(card!.y).toBeLessThan(box!.y + box!.height);
    });

    test("a peer expands and collapses, and its toggle keeps focus", async ({ page }) => {
      await gotoRoute(page, origin, "topology");
      const toggle = toggles(page).first();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(toggles(page).first()).toHaveAttribute("aria-expanded", "true");
      await expect(routeCards(page)).toHaveCount(13);
      await expect(toggles(page).first()).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(toggles(page).first()).toHaveAttribute("aria-expanded", "false");
      await expect(routeCards(page)).toHaveCount(10);
    });

    test("the filter narrows to matching routes, opened, by name or peer", async ({ page }) => {
      await gotoRoute(page, origin, "topology");
      const filter = page.locator("#topology-filter");
      await page.keyboard.press("/");
      await expect(filter).toBeFocused();

      await filter.fill("service-31");
      await expect(routeCards(page)).toHaveCount(1);
      await expect(routeCards(page).first()).toContainText("service-31");
      await expect(page.locator("#topology-scale-summary")).toHaveText("1 of 31 routes match, on 1 peer(s)");

      await filter.fill("peer-01");
      await expect(toggles(page)).toHaveCount(1);
      await expect(routeCards(page)).toHaveCount(4);

      await filter.fill("no such thing");
      await expect(page.locator("#topology-svg .topology-empty-text")).toHaveText("No routes match this filter");

      await filter.fill("");
      await expect(toggles(page)).toHaveCount(10);
      await expect(routeCards(page)).toHaveCount(10);
    });

    test("a poll keeps what is open and where the graph is", async ({ page }) => {
      await gotoRoute(page, origin, "topology");
      await page.locator("#topology-expand-all").click();
      await expect(routeCards(page)).toHaveCount(31);
      const graph = page.locator("#topology-svg");
      await graph.hover();
      await page.mouse.wheel(0, 40);
      const layer = page.locator("#topology-pan-zoom-layer");
      await expect(layer).toHaveAttribute("transform", /,-40\)/);
      await page.waitForResponse((r) => r.url().endsWith("/api/v1/stats"), { timeout: 15_000 });
      await expect(routeCards(page)).toHaveCount(31);
      await expect(layer).toHaveAttribute("transform", /,-40\)/);
    });
  });
});

test.describe("at normal sizes", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("topology draws every route and has no scale controls", async ({ page, request }) => {
    const routes = (await getConfig(request)).forwarding.routes;
    await gotoRoute(page, origin, "topology");
    await expect(page.locator("#topology-svg .topology-node--route")).toHaveCount(routes.length);
    await expect(page.locator("#topology-svg [data-topo-toggle]")).toHaveCount(0);
    await expect(page.locator("#topology-scale-controls")).toBeHidden();
  });
});

test.describe("route name", () => {
  let snapshot: any;

  test.beforeEach(async ({ page, request }) => {
    snapshot = await getConfig(request);
    await seed(page, { scheme: "light" });
  });

  test.afterEach(async ({ request }) => {
    await putConfig(request, snapshot);
  });

  const unnamed = (cfg: any) => ({
    ...cfg,
    forwarding: {
      ...cfg.forwarding,
      routes: cfg.forwarding.routes.map(({ name, ...rest }: any) => rest),
    },
  });

  test("a config with no names has no Name column, and saving adds none", async ({ page, request }) => {
    await putConfig(request, unnamed(snapshot));
    await gotoRoute(page, origin, "routes");
    await expect(page.locator("#routes-table-wrap thead th").first()).toContainText("Proto");

    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await page.locator("#route-save").click();
    await expect(page.locator("#route-modal")).toBeHidden();
    const saved = (await getConfig(request)).forwarding.routes[0];
    expect(saved).not.toHaveProperty("name");
  });

  test("a name set in the editor leads the row, and clearing it removes the key", async ({ page, request }) => {
    await putConfig(request, unnamed(snapshot));
    await gotoRoute(page, origin, "routes");

    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await expect(page.locator("#route-f-name")).toBeFocused();
    await page.locator("#route-f-name").fill("  Game server  ");
    await page.locator("#route-save").click();
    await expect(page.locator("#route-modal")).toBeHidden();

    await expect(page.locator("#routes-table-wrap thead th").first()).toContainText("Name");
    await expect(page.locator("#routes-table-wrap tbody tr td").first()).toHaveText("Game server");
    expect((await getConfig(request)).forwarding.routes[0].name).toBe("Game server");

    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await expect(page.locator("#route-f-name")).toHaveValue("Game server");
    await page.locator("#route-f-name").fill("");
    await page.locator("#route-save").click();
    await expect(page.locator("#route-modal")).toBeHidden();
    expect((await getConfig(request)).forwarding.routes[0]).not.toHaveProperty("name");
  });

  test("the name is filterable and shown as text, not markup", async ({ page, request }) => {
    const cfg = unnamed(snapshot);
    cfg.forwarding.routes[0].name = "<b>bold</b> & co";
    await putConfig(request, cfg);
    await gotoRoute(page, origin, "routes");
    await expect(page.locator("#routes-table-wrap tbody td.route-name-cell").first()).toHaveText("<b>bold</b> & co");
    await page.locator("#routes-filter").fill("bold");
    await expect(page.locator("#routes-table-wrap tbody tr:not(.is-filter-hidden)")).toHaveCount(1);

    await gotoRoute(page, origin, "topology");
    await expect(page.locator("#topology-svg .topology-route-name").first()).toHaveText("<b>bold</b> & co");
  });

  test("the mock rejects a name the real API would", async ({ request }) => {
    const cfg = unnamed(snapshot);
    cfg.forwarding.routes[0].name = "bad\nname";
    const res = await request.put(configUrl, {
      headers: { ...auth(), "Content-Type": "application/json" },
      data: cfg,
    });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("forwarding.routes[0]");
  });
});
