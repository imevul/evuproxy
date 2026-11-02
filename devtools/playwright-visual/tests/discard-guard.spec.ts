/**
 * Unsaved edits must not vanish silently: a dirty dialog warns on Escape,
 * backdrop and Cancel, and a dirty page form warns on navigation and tab close.
 * Clean forms keep closing without a prompt.
 */
import { expect, test, type Page } from "@playwright/test";

import { gotoRoute, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

const routeModal = (page: Page) => page.locator("#route-modal");
const ports = (page: Page) => page.locator("#page-routes #route-f-ports");
const prompt = (page: Page) => page.locator("#confirm-modal");
const keepEditing = (page: Page) => page.locator("#confirm-modal-cancel");
const discard = (page: Page) => page.locator("#confirm-modal-ok");

async function openAddRoute(page: Page): Promise<void> {
  await gotoRoute(page, origin, "routes");
  await page.locator("#page-routes #routes-add").click();
  await expect(routeModal(page)).not.toHaveClass(/is-hidden/);
}

/** Break-glass lives on the Advanced tab, which needs Advanced mode. */
async function fillBreakGlass(page: Page): Promise<void> {
  await page.locator("#page-geoblocking #geo-tab-advanced-btn").click();
  await page.locator("#page-geoblocking #geo-f-break-glass").fill("203.0.113.5/32");
}

async function editGeoForm(page: Page): Promise<void> {
  await seed(page, { scheme: "light", advanced: true });
  await gotoRoute(page, origin, "geoblocking");
  await fillBreakGlass(page);
  await expect(page.locator("#page-geoblocking .save-bar")).toBeVisible();
}

const navLink = (page: Page, route: string) => page.locator(`.nav-link[data-route="${route}"]`);

test.describe("discard guard: dialogs", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("Escape on a clean dialog closes it without a prompt", async ({ page }) => {
    await openAddRoute(page);
    await page.keyboard.press("Escape");
    await expect(routeModal(page)).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);
    await expect(page.locator("#page-routes #routes-add")).toBeFocused();
  });

  test("an edit that was undone counts as clean", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");
    await ports(page).fill("");
    await page.keyboard.press("Escape");
    await expect(routeModal(page)).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);
  });

  test("Escape on a dirty dialog warns, and keeping the edits keeps the text", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");
    await ports(page).focus();

    await page.keyboard.press("Escape");
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await expect(routeModal(page)).not.toHaveClass(/is-hidden/);
    await expect(keepEditing(page)).toHaveText("Keep editing");
    await expect(keepEditing(page)).toBeFocused();

    // The prompt is the top of the stack, so Escape answers it, not the editor.
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toHaveClass(/is-hidden/);
    await expect(routeModal(page)).not.toHaveClass(/is-hidden/);
    await expect(ports(page)).toHaveValue("8080");
    await expect(ports(page)).toBeFocused();
    expect(await routeModal(page).evaluate((el) => !!el.closest("[inert]"))).toBe(false);
  });

  test("discarding closes the dialog, clears the text and returns focus", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");
    await page.keyboard.press("Escape");
    await discard(page).click();

    await expect(routeModal(page)).toHaveClass(/is-hidden/);
    await expect(page.locator("body")).not.toHaveClass(/is-modal-open/);
    await expect(page.locator("#page-routes #routes-add")).toBeFocused();

    await page.locator("#page-routes #routes-add").click();
    await expect(ports(page)).toHaveValue("");
  });

  test("the prompt leaves the dirty dialog inert underneath it", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");
    await page.keyboard.press("Escape");
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    expect(await routeModal(page).evaluate((el) => !!el.closest("[inert]"))).toBe(true);
    expect(await prompt(page).evaluate((el) => !!el.closest("[inert]"))).toBe(false);
  });

  test("Cancel and the backdrop warn on a dirty dialog", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");

    await page.locator("#page-routes #route-cancel").click();
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await keepEditing(page).click();
    await expect(ports(page)).toHaveValue("8080");

    await routeModal(page).locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await keepEditing(page).click();
    await expect(routeModal(page)).not.toHaveClass(/is-hidden/);
  });

  test("Cancel and the backdrop close a clean dialog without a prompt", async ({ page }) => {
    await openAddRoute(page);
    await page.locator("#page-routes #route-cancel").click();
    await expect(routeModal(page)).toHaveClass(/is-hidden/);

    await page.locator("#page-routes #routes-add").click();
    await routeModal(page).locator(".modal-backdrop").click({ position: { x: 5, y: 5 } });
    await expect(routeModal(page)).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);
  });

  test("the generated keypair does not make a new peer dirty", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#page-peers #peers-add-start").click();
    await expect(page.locator("#page-peers #peer-f-pub")).not.toHaveValue("");

    await page.keyboard.press("Escape");
    await expect(page.locator("#peer-modal")).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);
  });

  test("a dirty peer editor warns only once help above it has closed", async ({ page }) => {
    await gotoRoute(page, origin, "peers");
    await page.locator("#page-peers [data-peer-edit]").first().click();
    await page.locator("#page-peers #peer-f-name").fill("renamed");
    await page.locator('#peer-modal button[data-help-template]').first().click();
    await expect(page.locator("#context-help-modal")).not.toHaveClass(/is-hidden/);

    await page.keyboard.press("Escape");
    await expect(page.locator("#context-help-modal")).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);

    await page.keyboard.press("Escape");
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#peer-modal")).not.toHaveClass(/is-hidden/);
  });

  test("changing the hash under a dirty dialog warns first", async ({ page }) => {
    await openAddRoute(page);
    await ports(page).fill("8080");

    await page.evaluate(() => {
      location.hash = "#/overview";
    });
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);

    await keepEditing(page).click();
    await expect(page).toHaveURL(/#\/routes$/);
    await expect(ports(page)).toHaveValue("8080");
  });

  test("the country picker warns when its selection changed", async ({ page }) => {
    await gotoRoute(page, origin, "geoblocking");
    const picker = page.locator("#geo-country-modal");
    await page.locator("#page-geoblocking #geo-tags-edit").click();
    await expect(picker).not.toHaveClass(/is-hidden/);

    // Search alone changes no selection.
    await page.locator("#geo-modal-search").fill("swe");
    await page.keyboard.press("Escape");
    await expect(picker).toHaveClass(/is-hidden/);
    await expect(prompt(page)).toHaveClass(/is-hidden/);

    await page.locator("#page-geoblocking #geo-tags-edit").click();
    await picker.locator('input[data-geo-code]').first().click();
    await page.keyboard.press("Escape");
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
  });
});

test.describe("discard guard: page forms", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("leaving a clean Geoblock form does not prompt", async ({ page }) => {
    await gotoRoute(page, origin, "geoblocking");
    await navLink(page, "routes").click();
    await expect(page.locator("#page-routes")).toBeVisible();
    await expect(prompt(page)).toHaveClass(/is-hidden/);

    // Returning must not read the reloading form as dirty either.
    await navLink(page, "geoblocking").click();
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(prompt(page)).toHaveClass(/is-hidden/);
    await expect(page.locator("#page-geoblocking .save-bar")).toBeHidden();
  });

  test("leaving a dirty Geoblock form warns, and staying keeps the edits", async ({ page }) => {
    await editGeoForm(page);
    await navLink(page, "routes").click();

    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await expect(page.locator("#page-routes")).toBeHidden();

    await keepEditing(page).click();
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await expect(page).toHaveURL(/#\/geoblocking$/);
    await expect(page.locator("#page-geoblocking #geo-f-break-glass")).toHaveValue("203.0.113.5/32");
  });

  test("discarding leaves Geoblock, and the edits are gone on return", async ({ page }) => {
    await editGeoForm(page);
    await navLink(page, "routes").click();
    await discard(page).click();

    await expect(page.locator("#page-routes")).toBeVisible();
    await expect(page).toHaveURL(/#\/routes$/);
    await expect(page.locator("#page-geoblocking")).toBeHidden();

    await navLink(page, "geoblocking").click();
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await expect(page.locator("#page-geoblocking #geo-f-break-glass")).not.toHaveValue("203.0.113.5/32");
    await expect(prompt(page)).toHaveClass(/is-hidden/);
  });

  test("the back button warns too, and staying restores the URL", async ({ page }) => {
    await seed(page, { scheme: "light", advanced: true });
    await gotoRoute(page, origin, "routes");
    await navLink(page, "geoblocking").click();
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await fillBreakGlass(page);

    await page.goBack();
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await page.keyboard.press("Escape");

    await expect(page).toHaveURL(/#\/geoblocking$/);
    await expect(page.locator("#page-geoblocking")).toBeVisible();
    await expect(page.locator("#page-geoblocking #geo-f-break-glass")).toHaveValue("203.0.113.5/32");
  });

  test("Refresh warns before overwriting Geoblock edits", async ({ page }) => {
    await editGeoForm(page);
    await page.locator("#page-geoblocking #geo-refresh").click();
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);

    await keepEditing(page).click();
    await expect(page.locator("#page-geoblocking #geo-f-break-glass")).toHaveValue("203.0.113.5/32");
  });

  test("a rate limit edit counts as dirty", async ({ page }) => {
    await seed(page, { scheme: "light", advanced: true });
    await gotoRoute(page, origin, "geoblocking");
    await page.locator("#page-geoblocking #geo-tab-advanced-btn").click();
    await page.locator("#page-geoblocking #geo-f-rate-udp").fill("4242");
    await expect(page.locator("#page-geoblocking .save-bar")).toBeVisible();

    await navLink(page, "routes").click();
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
  });

  test("leaving dirty Settings notes warns", async ({ page }) => {
    await gotoRoute(page, origin, "settings");
    await page.locator("#page-settings #settings-tab-adv-btn").click();
    const notes = page.locator("#page-settings #config-notes-body");
    if (!(await notes.isVisible())) await page.locator("#page-settings #settings-tab-maint-btn").click();
    await notes.fill((await notes.inputValue()) + " edited");

    await navLink(page, "routes").click();
    await expect(prompt(page)).not.toHaveClass(/is-hidden/);
    await expect(page.locator("#page-settings")).toBeVisible();
  });

  test("beforeunload is armed only while something is dirty", async ({ page }) => {
    const unloadBlocked = () =>
      page.evaluate(() => {
        const ev = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(ev);
        return ev.defaultPrevented;
      });

    await seed(page, { scheme: "light", advanced: true });
    await gotoRoute(page, origin, "geoblocking");
    expect(await unloadBlocked()).toBe(false);

    await fillBreakGlass(page);
    expect(await unloadBlocked()).toBe(true);
  });

  test("closing a dirty tab raises the browser's beforeunload dialog", async ({ page }) => {
    await editGeoForm(page);
    // Chromium only shows the dialog once the page has had a real user gesture.
    await page.locator("#page-geoblocking #geo-f-break-glass").click();
    await page.keyboard.type(" ");

    const dialog = new Promise<string>((resolve) => {
      page.once("dialog", async (d) => {
        resolve(d.type());
        await d.dismiss();
      });
    });
    await page.close({ runBeforeUnload: true });
    expect(await dialog).toBe("beforeunload");
  });
});
