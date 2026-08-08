/**
 * Modal stacking behaviour: Escape order, background inertness, scroll lock and
 * focus restore. The peer editor is the only place that stacks two dialogs (the
 * QR code opens on top of it), so it carries the nesting assertions.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const hidden = (sel: string) => `${sel}.is-hidden`;

/**
 * Effective inertness. `el.inert` only reports the property on that element,
 * but inertness inherits: isolation is applied to the branch that contains a
 * modal, not always to the modal element itself.
 */
const isInert = (page: Page, sel: string) =>
  page.locator(sel).evaluate((el) => !!el.closest("[inert]"));

test.describe("modal stack", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("Escape closes the topmost dialog, not a fixed favourite", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#page-peers [data-peer-edit]").first().click();
    await expect(page.locator("#peer-modal")).not.toHaveClass(/is-hidden/);

    // Context help opens from inside the editor, so both are open at once.
    await page.locator('#peer-modal button[data-help-template]').first().click();
    await expect(page.locator("#context-help-modal")).not.toHaveClass(/is-hidden/);

    // First Escape takes the help dialog and leaves the editor it opened from.
    // The old fixed priority list happened to get this pair right and the QR
    // pair wrong; ordering by the stack makes it right for every pair.
    await page.keyboard.press("Escape");
    await expect(page.locator(hidden("#context-help-modal"))).toHaveCount(1);
    await expect(page.locator("#peer-modal")).not.toHaveClass(/is-hidden/);

    // Second Escape takes the editor.
    await page.keyboard.press("Escape");
    await expect(page.locator(hidden("#peer-modal"))).toHaveCount(1);
  });

  test("a nested dialog leaves the one below it inert but still open", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#page-peers [data-peer-edit]").first().click();
    await page.locator('#peer-modal button[data-help-template]').first().click();
    await expect(page.locator("#context-help-modal")).not.toHaveClass(/is-hidden/);

    // Isolation follows the top of the stack, so the editor underneath is inert
    // while help is up, and interactive again as soon as help closes.
    expect(await isInert(page, "#peer-modal")).toBe(true);
    expect(await isInert(page, "#context-help-modal")).toBe(false);

    await page.keyboard.press("Escape");
    expect(await isInert(page, "#peer-modal")).toBe(false);
    await expect(page.locator("body")).toHaveClass(/is-modal-open/);
  });

  test("the page behind a dialog is inert and cannot scroll", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    await expect(page.locator("body")).not.toHaveClass(/is-modal-open/);

    await page.locator("#page-peers [data-peer-edit]").first().click();
    await expect(page.locator("body")).toHaveClass(/is-modal-open/);

    // The sidebar is outside the dialog's branch, so it must be inert.
    expect(await isInert(page, ".evu-sidebar")).toBe(true);
    // The dialog itself must not have been caught by the sibling walk.
    expect(await isInert(page, "#peer-modal")).toBe(false);

    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/is-modal-open/);
    expect(await isInert(page, ".evu-sidebar")).toBe(false);
  });

  test("closing returns focus to the control that opened the dialog", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    const opener = page.locator("#page-peers [data-peer-edit]").first();
    await opener.click();
    await expect(page.locator("#peer-modal")).not.toHaveClass(/is-hidden/);

    await page.keyboard.press("Escape");
    await expect(opener).toBeFocused();
  });

  test("Escape falls through to the mobile drawer when no dialog is open", async ({ page }) => {
    await page.setViewportSize({ width: 480, height: 800 });
    await gotoRoute(page, origin, "peers");
    await page.locator("#shell-menu-toggle").click();
    await expect(page.locator("body")).toHaveClass(/is-nav-open/);

    await page.keyboard.press("Escape");
    await expect(page.locator("body")).not.toHaveClass(/is-nav-open/);
  });
});
