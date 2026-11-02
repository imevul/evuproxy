/**
 * Phone layout at 375×812 (style/mobile.css), with the large config on top of the mock
 * so the lists are at their widest. Touch emulation only: this cannot stand in for a
 * real device, but layout, reachability and target sizes all hold here.
 */
import { expect, test, type Page } from "@playwright/test";

import { ROUTES, gotoRoute, largeConfig, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";

test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

async function useLargeConfig(page: Page) {
  await page.route("**/api/v1/config", async (r) => {
    if (r.request().method() !== "GET") return r.continue();
    const res = await r.fetch();
    await r.fulfill({ response: res, json: largeConfig(await res.json()) });
  });
}

const pageWidth = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth);

/**
 * What a touch can hit: the control's box, grown by an invisible ::after if it has one.
 * Inline links in running text are exempt from target size (WCAG 2.5.8). So are the
 * Topology graph's toggles: they live in the scaled SVG, so their size follows its zoom,
 * and Expand all / Collapse all above the graph do the same job at full size.
 */
const smallTargets = (page: Page, route: string) =>
  page.evaluate((r) => {
    const scope = `#page-${r}`;
    const controls = document.querySelectorAll(
      `.evu-app-header button, ${scope} button, ${scope} select, ${scope} input:not([type=checkbox]):not([type=radio]), ${scope} .evu-switch`
    );
    return [...controls].flatMap((el) => {
      const box = el.getBoundingClientRect();
      if (!box.width || !box.height || el.classList.contains("topology-peer-toggle")) return [];
      const after = getComputedStyle(el, "::after");
      const grown = after.content !== "none" && after.position === "absolute";
      const w = Math.max(box.width, grown ? parseFloat(after.width) : 0);
      const h = Math.max(box.height, grown ? parseFloat(after.height) : 0);
      return w < 44 || h < 44 ? [`${el.tagName} ${el.id || el.className} ${Math.round(w)}x${Math.round(h)}`] : [];
    });
  }, route);

test.describe("phone layout", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await useLargeConfig(page);
  });

  for (const route of ROUTES) {
    test(`${route} fits the screen with 44px targets`, async ({ page }) => {
      await gotoRoute(page, origin, route);
      expect(await pageWidth(page)).toBeLessThanOrEqual(375);
      expect(await smallTargets(page, route)).toEqual([]);
    });
  }

  for (const [route, wrap, actions] of [
    ["routes", "routes-table-wrap", ["data-route-test", "data-route-edit", "data-route-del", "data-route-disabled"]],
    ["peers", "peers-table-wrap", ["data-peer-edit", "data-peer-del", "data-peer-disabled"]],
    ["inbound", "inbound-table-wrap", ["data-inbound-edit", "data-inbound-del", "data-inbound-disabled"]],
  ] as const) {
    test(`${route} row actions are on screen in every card`, async ({ page }) => {
      await gotoRoute(page, origin, route);
      await page.locator(`#${wrap} tbody tr`).first().waitFor();
      const offScreen = await page.evaluate(
        ([w, attrs]) =>
          (attrs as string[]).flatMap((a) =>
            [...document.querySelectorAll(`#${w} [${a}]`)].filter((el) => {
              // A switch's real input is visually hidden; its label is what shows.
              const b = (el.closest(".evu-switch") ?? el).getBoundingClientRect();
              return b.width === 0 || b.left < 0 || b.right > 375;
            }).map((el) => el.outerHTML.slice(0, 80))
          ),
        [wrap, actions] as const
      );
      expect(offScreen).toEqual([]);
    });
  }

  test("a row action works from its card", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("[data-route-edit]").first().tap();
    await expect(page.locator("#route-editor-modal, .modal:not(.is-hidden)").first()).toBeVisible();
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);
  });

  test("cards keep sorting and table semantics", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const wrap = page.locator("#routes-table-wrap");
    await expect(wrap.getByRole("table")).toBeVisible();
    await expect(wrap.getByRole("row").nth(1).getByRole("cell").first()).toBeVisible();
    const sort = wrap.getByRole("button", { name: "Ports", exact: true });
    await sort.tap();
    await expect(wrap.getByRole("columnheader", { name: "Ports" })).toHaveAttribute("aria-sort", "ascending");
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);
  });

  test("the filter still hides cards", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const rows = page.locator("#routes-table-wrap tbody tr:not(.row-error)");
    const total = await rows.count();
    await page.locator("#routes-filter").fill("service-01");
    await expect(rows.locator("visible=true")).toHaveCount(1);
    expect(total).toBeGreaterThan(1);
  });

  test("logs lines become cards with their actions on screen", async ({ page }) => {
    await gotoRoute(page, origin, "logs");
    await page.locator("#logs-table-wrap tbody tr").first().waitFor();
    const off = await page.evaluate(() =>
      [...document.querySelectorAll("#logs-table-wrap [data-logs-breakglass]")].filter((el) => {
        const b = el.getBoundingClientRect();
        return b.left < 0 || b.right > 375;
      }).length
    );
    expect(off).toBe(0);
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);
  });

  test("one header, far shorter than the two it replaced", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await expect(page.locator(".evu-main__topbar")).toHaveCount(0);
    const top = await page.locator("#page-routes").evaluate((el) => el.getBoundingClientRect().top);
    expect(top).toBeLessThan(100);
    await expect(page.locator("#shell-menu-toggle")).toBeVisible();
    await expect(page.locator("#api-status")).toBeVisible();
  });

  test("the drawer casts a shadow only while open and stays out of Tab order when closed", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const drawer = page.locator(".evu-sidebar");
    const shadow = () => drawer.evaluate((el) => getComputedStyle(el).boxShadow);
    expect(await shadow()).toBe("none");
    await expect(drawer).toBeHidden();

    await page.locator("#shell-menu-toggle").tap();
    await expect(page.locator("body")).toHaveClass(/is-nav-open/);
    await expect(drawer.locator(".nav-link").first()).toBeFocused();
    expect(await shadow()).not.toBe("none");
    expect(await pageWidth(page)).toBeLessThanOrEqual(375);

    await page.keyboard.press("Escape");
    await expect(page.locator("#shell-menu-toggle")).toBeFocused();
    await expect(drawer).toBeHidden();
    expect(await shadow()).toBe("none");
  });

  test("the toggle has moved but the drawer still navigates", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.locator("#shell-menu-toggle").tap();
    await page.locator('.nav-link[data-route="peers"]').tap();
    await expect(page.locator("#page-peers")).toBeVisible();
    await expect(page.locator("body")).not.toHaveClass(/is-nav-open/);
  });
});

test.describe("from the breakpoint up", () => {
  test.use({ viewport: { width: 768, height: 800 }, isMobile: false, hasTouch: false });

  test("768px keeps the table and the sidebar", async ({ page }) => {
    await seed(page, { scheme: "light" });
    await gotoRoute(page, origin, "routes");
    await expect(page.locator(".evu-sidebar")).toBeVisible();
    await expect(page.locator("#shell-menu-toggle")).toBeHidden();
    const display = await page.locator("#routes-table-wrap table").evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("table");
  });
});
