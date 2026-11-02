/**
 * Over an SSH tunnel every request can take seconds, so navigation must answer the
 * click before the network does. API responses are held back here, not just slowed,
 * so "before the response arrives" is a fact of the test rather than a timing bet.
 */
import { expect, test, type Page, type Route as PwRoute } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

/** Holds every API response until the returned function is called. */
async function holdApi(page: Page): Promise<() => Promise<void>> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler = async (route: PwRoute): Promise<void> => {
    await released;
    await route.continue().catch(() => undefined);
  };
  await page.route("**/api/**", handler);
  return async () => {
    release();
    await page.unroute("**/api/**", handler);
  };
}

const navLink = (page: Page, route: string) => page.locator(`.nav-link[data-route="${route}"]`);

test.describe("navigation answers before the network", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await gotoRoute(page, origin, "overview");
  });

  test("the page and highlight switch before the response arrives", async ({ page }) => {
    const release = await holdApi(page);
    await navLink(page, "routes").click();

    // Short timeouts on purpose: the API is still held, so this cannot be the response.
    await expect(page.locator("#page-routes")).toBeVisible({ timeout: 1_000 });
    await expect(page.locator("#page-overview")).toBeHidden({ timeout: 1_000 });
    await expect(navLink(page, "routes")).toHaveClass(/is-active/, { timeout: 1_000 });
    await expect(navLink(page, "routes")).toHaveAttribute("aria-current", "page", { timeout: 1_000 });
    await expect(navLink(page, "overview")).not.toHaveAttribute("aria-current", "page", { timeout: 1_000 });
    expect(page.url()).toContain("#/routes");
    await expect(page.locator("#routes-table-wrap table.data")).toHaveCount(0);

    await release();
    await expect(page.locator("#routes-table-wrap table.data")).toBeVisible();
    await expect(navLink(page, "routes")).toHaveClass(/is-active/);
  });

  test("the later of two quick clicks wins, whichever load finishes first", async ({ page }) => {
    const release = await holdApi(page);
    await navLink(page, "routes").click();
    await navLink(page, "inbound").click();
    await expect(page.locator("#page-inbound")).toBeVisible({ timeout: 1_000 });

    await release();
    await expect(page.locator("#inbound-table-wrap table.data")).toBeVisible();
    await expect(page.locator("#page-routes")).toBeHidden();
    await expect(navLink(page, "inbound")).toHaveAttribute("aria-current", "page");
    expect(page.url()).toContain("#/inbound");
  });

  test("one click loads the page once", async ({ page }) => {
    let configRequests = 0;
    page.on("request", (req) => {
      if (req.url().includes("/api/v1/config")) configRequests++;
    });
    await navLink(page, "routes").click();
    await expect(page.locator("#routes-table-wrap table.data")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(configRequests).toBe(1);
  });
});

test.describe("loading states", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await gotoRoute(page, origin, "overview");
  });

  test("an empty region is busy at once and shows a skeleton only after the delay", async ({ page }) => {
    const release = await holdApi(page);
    await navLink(page, "routes").click();

    const wrap = page.locator("#routes-table-wrap");
    await expect(wrap).toHaveAttribute("aria-busy", "true", { timeout: 200 });
    await expect(wrap.locator(".loading-skeleton")).toHaveCount(0);
    await expect(wrap.locator(".loading-skeleton")).toBeVisible();

    await release();
    await expect(wrap.locator("table.data")).toBeVisible();
    await expect(wrap.locator(".loading-skeleton")).toHaveCount(0);
    await expect(wrap).not.toHaveAttribute("aria-busy", "true");
  });

  test("a refresh keeps the old rows and dims them while it loads", async ({ page }) => {
    await navLink(page, "routes").click();
    const wrap = page.locator("#routes-table-wrap");
    await expect(wrap.locator("table.data")).toBeVisible();
    await expect(wrap).not.toHaveAttribute("aria-busy", "true");

    const release = await holdApi(page);
    await page.locator("#routes-refresh").click();
    await expect(wrap).toHaveAttribute("aria-busy", "true");
    await expect(wrap).toHaveClass(/is-loading/);
    await expect(wrap.locator("table.data")).toBeVisible();
    await expect(wrap.locator(".loading-skeleton")).toHaveCount(0);

    await release();
    await expect(wrap).not.toHaveClass(/is-loading/);
    await expect(wrap).not.toHaveAttribute("aria-busy", "true");
  });

  test("a failed load clears the busy state", async ({ page }) => {
    await page.route("**/api/v1/config", (route) =>
      route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"boom"}' })
    );
    await navLink(page, "inbound").click();
    await expect(page.locator("#inbound-msg")).toHaveText(/boom/);
    const wrap = page.locator("#inbound-table-wrap");
    await expect(wrap).not.toHaveAttribute("aria-busy", "true");
    await expect(wrap.locator(".loading-skeleton")).toHaveCount(0);
  });

  test("the page switch itself is not animated", async ({ page }) => {
    const release = await holdApi(page);
    await navLink(page, "routes").click();
    const running = await page
      .locator("#page-routes")
      .evaluate((el) => el.getAnimations({ subtree: false }).length);
    expect(running).toBe(0);
    await release();
  });
});
