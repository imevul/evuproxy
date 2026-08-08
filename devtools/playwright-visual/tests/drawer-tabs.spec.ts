/**
 * Keyboard behaviour for the mobile navigation drawer and the tablists.
 * Both are things axe cannot see: it checks roles and names, not whether focus
 * actually goes anywhere sensible.
 */
import { expect, test } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

test.describe("mobile navigation drawer", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await page.setViewportSize({ width: 480, height: 800 });
  });

  test("opening moves focus into the drawer and closing restores it", async ({ page }) => {
    await gotoRoute(page, origin, "overview");
    const toggle = page.locator("#shell-menu-toggle");

    await toggle.click();
    await expect(page.locator("body")).toHaveClass(/is-nav-open/);
    expect(
      await page.evaluate(() => !!document.querySelector(".evu-sidebar")?.contains(document.activeElement))
    ).toBe(true);

    await page.keyboard.press("Escape");
    await expect(toggle).toBeFocused();
  });

  test("Tab cycles inside the open drawer instead of escaping to the page", async ({ page }) => {
    await gotoRoute(page, origin, "overview");
    await page.locator("#shell-menu-toggle").click();

    const inDrawer = () =>
      page.evaluate(
        () => !!document.querySelector(".evu-sidebar")?.contains(document.activeElement)
      );

    // More presses than the drawer has stops, so an untrapped focus ring escapes.
    for (let i = 0; i < 30; i++) {
      await page.keyboard.press("Tab");
      expect(await inDrawer()).toBe(true);
    }
  });
});

test.describe("tablists", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("the list is a single tab stop", async ({ page }) => {
    await gotoRoute(page, origin, "settings");
    const stops = await page
      .locator("#page-settings .settings-page-tabs [role=tab]")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex));

    expect(stops.filter((t) => t === 0)).toHaveLength(1);
    expect(stops[0]).toBe(0);
  });

  test("arrows, Home and End move and activate the selection", async ({ page }) => {
    await gotoRoute(page, origin, "settings");
    const tabs = page.locator("#page-settings .settings-page-tabs [role=tab]");
    const first = tabs.first();
    await first.focus();

    await page.keyboard.press("ArrowRight");
    await expect(tabs.nth(1)).toBeFocused();
    await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(first).toHaveAttribute("aria-selected", "false");

    await page.keyboard.press("Home");
    await expect(first).toBeFocused();
    await expect(first).toHaveAttribute("aria-selected", "true");

    // Wraps backwards from the first tab to the last selectable one.
    await page.keyboard.press("ArrowLeft");
    const focusedId = await page.evaluate(() => document.activeElement?.id);
    const lastEnabledId = await tabs.evaluateAll(
      (els) =>
        els.filter((el) => el.getAttribute("aria-disabled") !== "true").pop()?.id
    );
    expect(focusedId).toBe(lastEnabledId);
  });

  // The Advanced gate used to write and remove `tabindex` itself, which handed a
  // second tab stop back to any tablist it ungated.
  test("ungating a tab does not add a second tab stop", async ({ page }) => {
    await seed(page, { scheme: "light", advanced: true });

    const stops = (selector: string) =>
      page
        .locator(selector)
        .evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex).filter((t) => t === 0));

    await gotoRoute(page, origin, "routes");
    await page.locator("#routes-add").click();
    await page.locator("#route-modal").waitFor({ state: "visible" });
    expect(await stops(".route-editor-tabs [role=tab]")).toHaveLength(1);

    await gotoRoute(page, origin, "geoblocking");
    expect(await stops(".geo-page-tabs [role=tab]")).toHaveLength(1);

    // Refresh no longer resets the tab, so nothing else re-syncs the stops for us.
    await page.locator("#geo-tab-zones-btn").click();
    await page.locator("#geo-refresh").click();
    await expect(page.locator("#geo-tab-zones-btn")).toHaveAttribute("aria-selected", "true");
    expect(await stops(".geo-page-tabs [role=tab]")).toHaveLength(1);
  });

  test("gated tabs are skipped rather than focused into a dead end", async ({ page }) => {
    // Advanced off: the geo Advanced tab is present but aria-disabled.
    await gotoRoute(page, origin, "geoblocking");
    const advanced = page.locator("#geo-tab-advanced-btn");
    await expect(advanced).toHaveAttribute("aria-disabled", "true");

    const first = page.locator("#geo-tab-default-btn");
    await first.focus();
    // Advanced sits between these two, so arrowing right has to step over it.
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#geo-tab-zones-btn")).toBeFocused();
    await expect(advanced).not.toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(first).toBeFocused();
  });
});
