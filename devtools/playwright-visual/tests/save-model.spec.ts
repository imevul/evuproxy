/**
 * One save model: a switch is already saved, a page of settings has one save bar that
 * exists only while dirty, a dialog's footer says Save, and a choice feeding a form
 * says Done.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "./fixtures";

import { SCHEMES, gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const configUrl = origin + "/api/v1/config";
const prefsUrl = origin + "/api/v1/preferences";
const notesUrl = origin + "/api/v1/config/notes";
const auth = () => ({ Authorization: "Bearer " + token(), "Content-Type": "application/json" });

const toast = (page: Page) => page.locator("#toaster .evu-toast");
const undo = (page: Page) => toast(page).getByRole("button", { name: "Undo" });
const bar = (page: Page, route: string) => page.locator(`#page-${route} .save-bar`);
const barSave = (page: Page, route: string) => bar(page, route).getByRole("button", { name: "Save" });
const barDiscard = (page: Page, route: string) => bar(page, route).getByRole("button", { name: "Discard" });
/** The visible part of a switch: its input is 0x0, so it cannot be clicked directly. */
const track = (page: Page, id: string): Locator => page.locator(`label.evu-switch:has(#${id})`);

async function getJson(request: APIRequestContext, url: string) {
  const res = await request.get(url, { headers: auth() });
  expect(res.ok()).toBeTruthy();
  return res.json();
}

async function putJson(request: APIRequestContext, url: string, data: unknown) {
  const res = await request.put(url, { headers: auth(), data });
  expect(res.ok()).toBeTruthy();
}

async function saveElsewhere(request: APIRequestContext, edit: (cfg: any) => void) {
  const cfg = await getJson(request, configUrl);
  edit(cfg);
  await putJson(request, configUrl, cfg);
}

/** An unsaved edit on the Geoblock form: picks the list mode that is not selected now. */
async function flipGeoMode(page: Page): Promise<string> {
  const off = page.locator('#page-geoblocking .geo-mode-btn:not(.is-active)');
  const mode = (await off.getAttribute("data-geo-mode")) as string;
  await off.click();
  return mode;
}

/** Records the URLs and bodies of every PUT the page sends to the API. */
function recordPuts(page: Page) {
  const puts: { path: string; body: any }[] = [];
  page.on("request", (req) => {
    if (req.method() !== "PUT") return;
    puts.push({ path: new URL(req.url()).pathname, body: req.postDataJSON() });
  });
  return puts;
}

function failPut(page: Page, glob: string, message: string) {
  return page.route(glob, (route) =>
    route.request().method() === "PUT"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: message }) })
      : route.fallback()
  );
}

/** Holds every PUT to `glob` until the returned function is called. */
async function holdPuts(page: Page, glob: string) {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(glob, async (route) => {
    if (route.request().method() === "PUT") await released;
    await route.fallback();
  });
  return release;
}

test.describe("save model", () => {
  let cfgSnapshot: unknown;
  let prefsSnapshot: unknown;
  let notesSnapshot: { text?: string };

  test.beforeEach(async ({ page, request }) => {
    cfgSnapshot = await getJson(request, configUrl);
    prefsSnapshot = await getJson(request, prefsUrl);
    notesSnapshot = await getJson(request, notesUrl);
    await seed(page, { scheme: "light", advanced: true });
  });

  test.afterEach(async ({ request }) => {
    await putJson(request, configUrl, cfgSnapshot);
    await putJson(request, prefsUrl, prefsSnapshot);
    await putJson(request, notesUrl, { text: notesSnapshot.text || "" });
  });

  test.describe("Geoblock switches", () => {
    test("an instant switch writes only its own field, not the unsaved form", async ({ page, request }) => {
      await gotoRoute(page, origin, "geoblocking");
      const before = await getJson(request, configUrl);
      const beforeInbound = !!before.geo.apply_to_input_allows;

      await flipGeoMode(page);
      await expect(bar(page, "geoblocking")).toBeVisible();

      await track(page, "geo-f-apply-input-allows").click();
      await expect(toast(page)).toHaveText(/inbound allow rules (enabled|disabled)/);
      await expect(undo(page)).toBeVisible();

      const after = await getJson(request, configUrl);
      expect(!!after.geo.apply_to_input_allows).toBe(!beforeInbound);
      expect(after.geo.mode).toBe(before.geo.mode);
      // Still dirty: the edit stays in the form, waiting for Save.
      await expect(bar(page, "geoblocking")).toBeVisible();
    });

    test("flipping a switch alone never raises the bar", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await track(page, "geo-f-apply-input-allows").click();
      await expect(toast(page)).toBeVisible();
      await expect(bar(page, "geoblocking")).toBeHidden();
    });

    test("Undo reverses into fresh config and keeps a change saved since", async ({ page, request }) => {
      await gotoRoute(page, origin, "geoblocking");
      const start = !!(await getJson(request, configUrl)).geo.apply_to_input_allows;
      const input = page.locator("#geo-f-apply-input-allows");

      await track(page, "geo-f-apply-input-allows").click();
      await expect(undo(page)).toBeVisible();
      await saveElsewhere(request, (c) => {
        c.peers[0].name = "saved-elsewhere";
      });

      await undo(page).click();
      await expect.poll(async () => !!(await getJson(request, configUrl)).geo.apply_to_input_allows).toBe(start);
      const cfg = await getJson(request, configUrl);
      expect(cfg.peers[0].name).toBe("saved-elsewhere");
      if (start) await expect(input).toBeChecked();
      else await expect(input).not.toBeChecked();
    });

    test("a rejected switch snaps back and shows the error next to it", async ({ page, request }) => {
      await saveElsewhere(request, (c) => {
        c.geo.enabled = false;
        c.geo.countries = [];
      });
      await gotoRoute(page, origin, "geoblocking");
      const input = page.locator("#geo-f-enabled");
      await expect(input).not.toBeChecked();

      await track(page, "geo-f-enabled").click();

      const err = page.locator("#geo-f-enabled-msg");
      await expect(err).toHaveText(/geo\.countries required/);
      await expect(input).not.toBeChecked();
      await expect(toast(page)).toHaveCount(0);
      expect((await getJson(request, configUrl)).geo.enabled).toBeFalsy();
      // Beside the switch, not somewhere down the page.
      await expect(page.locator(".geo-enable-row #geo-f-enabled-msg")).toHaveCount(1);
    });

    test("a rejected switch ignores countries that are only in the unsaved form", async ({ page, request }) => {
      await saveElsewhere(request, (c) => {
        c.geo.enabled = false;
        c.geo.countries = [];
      });
      await gotoRoute(page, origin, "geoblocking");
      await page.locator("#geo-tags-edit").click();
      await page.locator('#geo-modal-list input[data-geo-code="se"]').check();
      await page.locator("#geo-modal-done").click();
      await expect(bar(page, "geoblocking")).toBeVisible();

      await track(page, "geo-f-enabled").click();
      await expect(page.locator("#geo-f-enabled-msg")).toHaveText(/geo\.countries required/);
      await expect(page.locator("#geo-f-enabled")).not.toBeChecked();
      await expect(page.locator("#geo-tags-chips .geo-tag")).toHaveCount(1);
    });

    test("the error clears once the switch succeeds", async ({ page, request }) => {
      await saveElsewhere(request, (c) => {
        c.geo.enabled = false;
        c.geo.countries = [];
      });
      await gotoRoute(page, origin, "geoblocking");
      await track(page, "geo-f-enabled").click();
      await expect(page.locator("#geo-f-enabled-msg")).not.toBeEmpty();

      await saveElsewhere(request, (c) => {
        c.geo.countries = ["se"];
      });
      await track(page, "geo-f-enabled").click();
      await expect(toast(page)).toHaveText(/Geoblocking enabled/);
      await expect(page.locator("#geo-f-enabled-msg")).toBeEmpty();
      await expect(page.locator("#geo-f-enabled")).toBeChecked();
    });

    test("a failed Undo on a page you left shows an error toast", async ({ page, request }) => {
      await gotoRoute(page, origin, "geoblocking");
      const start = !!(await getJson(request, configUrl)).geo.apply_to_input_allows;
      await track(page, "geo-f-apply-input-allows").click();
      await expect(undo(page)).toBeVisible();

      await page.locator('.nav-link[data-route="routes"]').click();
      await expect(page.locator("#page-routes")).toBeVisible();
      await failPut(page, "**/api/v1/config", "disk full");
      await undo(page).click();

      await expect(toast(page)).toHaveText(/disk full/);
      await expect(toast(page)).toHaveAttribute("data-error", "");
      expect(!!(await getJson(request, configUrl)).geo.apply_to_input_allows).toBe(!start);
    });

    test("a failed Undo on the switch's own page stays beside the switch", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await track(page, "geo-f-apply-input-allows").click();
      await expect(undo(page)).toBeVisible();

      await failPut(page, "**/api/v1/config", "disk full");
      await undo(page).click();

      await expect(page.locator("#geo-f-apply-input-allows-msg")).toHaveText(/disk full/);
      await expect(page.locator("#geo-f-apply-input-allows-msg")).toBeVisible();
      await expect(toast(page)).toHaveCount(0);
    });
  });

  test.describe("save bar", () => {
    test("appears only when dirty and clears when the edit is undone by hand", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await expect(bar(page, "geoblocking")).toBeHidden();

      const original = await page.locator("#page-geoblocking .geo-mode-btn.is-active").getAttribute("data-geo-mode");
      await flipGeoMode(page);
      await expect(bar(page, "geoblocking")).toBeVisible();
      await expect(bar(page, "geoblocking")).toContainText("Unsaved changes");

      await page.locator(`#page-geoblocking .geo-mode-btn[data-geo-mode="${original}"]`).click();
      await expect(bar(page, "geoblocking")).toBeHidden();
    });

    test("Save writes, confirms and clears, and focus does not fall to the body", async ({ page, request }) => {
      await gotoRoute(page, origin, "geoblocking");
      const mode = await flipGeoMode(page);

      await barSave(page, "geoblocking").focus();
      await page.keyboard.press("Enter");

      await expect(toast(page)).toHaveText(/Geoblocking saved/);
      await expect(bar(page, "geoblocking")).toBeHidden();
      expect((await getJson(request, configUrl)).geo.mode).toBe(mode);
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    });

    test("a rejected Save keeps the bar and the edits, with the error in the bar", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      const mode = await flipGeoMode(page);
      await failPut(page, "**/api/v1/config", "disk full");

      await barSave(page, "geoblocking").click();

      await expect(bar(page, "geoblocking").locator(".save-bar__error")).toHaveText(/disk full/);
      await expect(bar(page, "geoblocking")).toBeVisible();
      await expect(page.locator(`#page-geoblocking .geo-mode-btn[data-geo-mode="${mode}"]`)).toHaveClass(/is-active/);
      await expect(toast(page)).toHaveCount(0);
    });

    test("Discard warns, then restores the form and clears", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      const original = await page.locator("#page-geoblocking .geo-mode-btn.is-active").getAttribute("data-geo-mode");
      await flipGeoMode(page);

      await barDiscard(page, "geoblocking").click();
      await expect(page.locator("#confirm-modal")).not.toHaveClass(/is-hidden/);
      await page.locator("#confirm-modal-cancel").click();
      await expect(bar(page, "geoblocking")).toBeVisible();

      await barDiscard(page, "geoblocking").click();
      await page.locator("#confirm-modal-ok").click();
      await expect(bar(page, "geoblocking")).toBeHidden();
      await expect(page.locator(`#page-geoblocking .geo-mode-btn[data-geo-mode="${original}"]`)).toHaveClass(/is-active/);
      expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
    });

    test("an edit made during the save stays in the form, and the bar stays up", async ({ page, request }) => {
      await gotoRoute(page, origin, "geoblocking");
      const original = await page.locator("#page-geoblocking .geo-mode-btn.is-active").getAttribute("data-geo-mode");
      const sent = await flipGeoMode(page);
      const release = await holdPuts(page, "**/api/v1/config");

      await barSave(page, "geoblocking").click();
      await page.locator(`#page-geoblocking .geo-mode-btn[data-geo-mode="${original}"]`).click();
      release();

      await expect(toast(page)).toHaveText(/Geoblocking saved/);
      expect((await getJson(request, configUrl)).geo.mode).toBe(sent);
      await expect(page.locator(`#page-geoblocking .geo-mode-btn[data-geo-mode="${original}"]`)).toHaveClass(/is-active/);
      await expect(bar(page, "geoblocking")).toBeVisible();

      // Leaving still warns, and a second Save writes the later edit and clears the bar.
      await page.locator('.nav-link[data-route="routes"]').click();
      await expect(page.locator("#confirm-modal")).not.toHaveClass(/is-hidden/);
      await page.locator("#confirm-modal-cancel").click();
      await barSave(page, "geoblocking").click();
      await expect(bar(page, "geoblocking")).toBeHidden();
      expect((await getJson(request, configUrl)).geo.mode).toBe(original);
    });

    test("a form left alone during the save is reloaded from what was saved", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await page.locator("#geo-tab-advanced-btn").click();
      const field = page.locator("#geo-f-break-glass");
      await field.fill("203.0.113.5/32   203.0.113.6/32");
      const release = await holdPuts(page, "**/api/v1/config");

      await barSave(page, "geoblocking").click();
      release();

      await expect(field).toHaveValue("203.0.113.5/32, 203.0.113.6/32");
      await expect(bar(page, "geoblocking")).toBeHidden();
    });

    test("covers Geoblock's tabs, but not the read-only Zone files", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await page.locator("#geo-tab-advanced-btn").click();
      await page.locator("#geo-f-break-glass").fill("203.0.113.5/32");
      await expect(bar(page, "geoblocking")).toBeVisible();

      await page.locator("#geo-tab-default-btn").click();
      await expect(bar(page, "geoblocking")).toBeVisible();

      await page.locator("#geo-tab-zones-btn").click();
      await expect(bar(page, "geoblocking")).toBeHidden();

      // Hidden is not clean: the edits survive, and leaving still warns.
      await page.locator('.nav-link[data-route="routes"]').click();
      await expect(page.locator("#confirm-modal")).not.toHaveClass(/is-hidden/);
      await page.locator("#confirm-modal-cancel").click();

      await page.locator("#geo-tab-advanced-btn").click();
      await expect(bar(page, "geoblocking")).toBeVisible();
      await expect(page.locator("#geo-f-break-glass")).toHaveValue("203.0.113.5/32");
    });

    test("sticks to the viewport on a page taller than the screen", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 420 });
      await gotoRoute(page, origin, "geoblocking");
      await flipGeoMode(page);

      const box = await bar(page, "geoblocking").boundingBox();
      expect(box).not.toBeNull();
      expect(box!.y + box!.height).toBeLessThanOrEqual(420);
      await expect(barSave(page, "geoblocking")).toBeInViewport();
    });

    test("a page has at most one, on Geoblock and Settings only", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await expect(page.locator(".save-bar")).toHaveCount(2);
      await expect(page.locator("#page-settings .save-bar")).toHaveCount(1);
      await expect(page.locator("#page-geoblocking .save-bar")).toHaveCount(1);
    });
  });

  test.describe("Settings", () => {
    test("the metrics switch is instant and sends only its own field", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      const endpoint = page.locator("#settings-wg-endpoint");
      await endpoint.fill("unsaved.example.com:51820");
      const puts = recordPuts(page);
      const before = !!(await getJson(request, prefsUrl)).metrics_collection_enabled;

      await track(page, "settings-metrics-collection").click();
      await expect(toast(page)).toHaveText(/Peer ICMP metrics (enabled|disabled)/);
      await expect(undo(page)).toBeVisible();

      expect(puts).toEqual([{ path: "/api/v1/preferences", body: { metrics_collection_enabled: !before } }]);
      await expect(bar(page, "settings")).toBeVisible();
      await expect(endpoint).toHaveValue("unsaved.example.com:51820");
    });

    test("a failed metrics switch snaps back with the error beside it", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      const input = page.locator("#settings-metrics-collection");
      const before = await input.isChecked();
      await failPut(page, "**/api/v1/preferences", "disk full");

      await track(page, "settings-metrics-collection").click();

      await expect(page.locator("#settings-metrics-collection-msg")).toHaveText(/disk full/);
      expect(await input.isChecked()).toBe(before);
    });

    test("a second flip during the metrics write is ignored, so the UI and server agree", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      const input = page.locator("#settings-metrics-collection");
      const before = await input.isChecked();
      const puts = recordPuts(page);
      const release = await holdPuts(page, "**/api/v1/preferences");

      await track(page, "settings-metrics-collection").click();
      await track(page, "settings-metrics-collection").click();
      expect(await input.isChecked()).toBe(!before);
      release();

      await expect(toast(page)).toHaveText(/Peer ICMP metrics (enabled|disabled)/);
      expect(puts).toEqual([{ path: "/api/v1/preferences", body: { metrics_collection_enabled: !before } }]);
      expect(await input.isChecked()).toBe(!before);
      expect(!!(await getJson(request, prefsUrl)).metrics_collection_enabled).toBe(!before);
    });

    test("a failed metrics Undo on a page you left shows an error toast", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await track(page, "settings-metrics-collection").click();
      await expect(undo(page)).toBeVisible();

      await page.locator('.nav-link[data-route="routes"]').click();
      await expect(page.locator("#page-routes")).toBeVisible();
      await failPut(page, "**/api/v1/preferences", "disk full");
      await undo(page).click();

      await expect(toast(page)).toHaveText(/disk full/);
      await expect(toast(page)).toHaveAttribute("data-error", "");
    });

    test("an edit made during the save stays dirty, and a second Save writes it", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-tab-maint-btn").click();
      const notes = page.locator("#config-notes-body");
      await notes.fill("first");
      const release = await holdPuts(page, "**/api/v1/config/notes");

      await barSave(page, "settings").click();
      await notes.fill("first and second");
      release();

      await expect(toast(page)).toHaveText(/Settings saved/);
      expect((await getJson(request, notesUrl)).text).toBe("first");
      await expect(notes).toHaveValue("first and second");
      await expect(bar(page, "settings")).toBeVisible();

      // Leaving still warns, and a second Save writes the later edit and clears the bar.
      await page.locator('.nav-link[data-route="routes"]').click();
      await expect(page.locator("#confirm-modal")).not.toHaveClass(/is-hidden/);
      await page.locator("#confirm-modal-cancel").click();
      await barSave(page, "settings").click();
      await expect(bar(page, "settings")).toBeHidden();
      expect((await getJson(request, notesUrl)).text).toBe("first and second");
    });

    test("an edit in another store during the save stays dirty too", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      const iface = page.locator("#settings-public-interface");
      const endpoint = page.locator("#settings-wg-endpoint");
      await endpoint.fill("sent.example.com:51820");
      const release = await holdPuts(page, "**/api/v1/preferences");

      await barSave(page, "settings").click();
      await iface.fill("eth9");
      release();

      await expect(toast(page)).toHaveText(/Settings saved/);
      expect((await getJson(request, prefsUrl)).wireguard_server_endpoint).toBe("sent.example.com:51820");
      await expect(iface).toHaveValue("eth9");
      await expect(bar(page, "settings")).toBeVisible();
    });

    test("one bar covers Preferences and Notes", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-wg-endpoint").fill("vpn.test.example:51820");
      await page.locator("#settings-tab-maint-btn").click();
      await page.locator("#config-notes-body").fill("written by the save bar");
      await expect(bar(page, "settings")).toBeVisible();

      await barSave(page, "settings").click();
      await expect(toast(page)).toHaveText(/Settings saved/);
      await expect(bar(page, "settings")).toBeHidden();
      expect((await getJson(request, prefsUrl)).wireguard_server_endpoint).toBe("vpn.test.example:51820");
      expect((await getJson(request, notesUrl)).text).toBe("written by the save bar");
    });

    test("only the stores that changed are written", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-tab-maint-btn").click();
      await page.locator("#config-notes-body").fill("only notes");
      const puts = recordPuts(page);

      await barSave(page, "settings").click();
      await expect(toast(page)).toHaveText(/Settings saved/);
      expect(puts.map((p) => p.path)).toEqual(["/api/v1/config/notes"]);
    });

    test("when the second store fails, the first stays saved and Save retries only the rest", async ({ page, request }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-wg-endpoint").fill("partial.example.com:51820");
      await page.locator("#settings-public-interface").fill("eth9");
      await page.route("**/api/v1/config", (route) =>
        route.request().method() === "PUT"
          ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' })
          : route.fallback()
      );

      await barSave(page, "settings").click();

      const err = bar(page, "settings").locator(".save-bar__error");
      await expect(err).toContainText("Public interface: disk full");
      await expect(err).toContainText("Already saved: Preferences");
      await expect(bar(page, "settings")).toBeVisible();
      await expect(toast(page)).toHaveCount(0);
      expect((await getJson(request, prefsUrl)).wireguard_server_endpoint).toBe("partial.example.com:51820");

      await page.unroute("**/api/v1/config");
      const puts = recordPuts(page);
      await barSave(page, "settings").click();
      await expect(toast(page)).toHaveText(/needs Apply/);
      await expect(bar(page, "settings")).toBeHidden();
      expect(puts.map((p) => p.path)).toEqual(["/api/v1/config"]);
      expect((await getJson(request, configUrl)).network.public_interface).toBe("eth9");
    });

    test("an invalid value writes nothing at all", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-wg-endpoint").fill("valid.example.com:51820");
      await page.locator("#settings-public-interface").fill("not a valid interface name");
      const puts = recordPuts(page);

      await barSave(page, "settings").click();
      await expect(bar(page, "settings").locator(".save-bar__error")).toHaveText(/Invalid public interface/);
      expect(puts).toEqual([]);
    });

    test("Discard restores the fields", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      const iface = page.locator("#settings-public-interface");
      const original = await iface.inputValue();
      await iface.fill("eth9");

      await barDiscard(page, "settings").click();
      await page.locator("#confirm-modal-ok").click();
      await expect(iface).toHaveValue(original);
      await expect(bar(page, "settings")).toBeHidden();
    });

    test("Public interface is marked as needing Apply", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await expect(page.locator('#page-settings .field:has(#settings-public-interface) .evu-badge')).toHaveText("Needs Apply");
    });

    test("Backup and Restore stay named actions, away from the bar", async ({ page }) => {
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-tab-maint-btn").click();
      await expect(page.locator("#btn-backup-run")).toHaveText("Create backup");
      await expect(page.locator("#btn-restore-run")).toHaveText("Restore");
      await expect(bar(page, "settings").locator("#btn-backup-run, #btn-restore-run")).toHaveCount(0);
    });
  });

  test.describe("labels", () => {
    test("no leftover Save variants anywhere in the markup", async ({ page }) => {
      await gotoRoute(page, origin, "overview");
      const labels = await page
        .locator("button")
        .evaluateAll((els) => els.map((el) => (el.textContent || "").trim()).filter((t) => /^Save\b/.test(t)));
      expect(labels.filter((t) => t !== "Save")).toEqual([]);
    });

    test("the country picker says Done, and writes nothing", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await page.locator("#geo-tags-edit").click();
      const done = page.locator("#geo-modal-done");
      await expect(done).toHaveText("Done");
      const puts = recordPuts(page);
      await page.locator("#geo-modal-list input[data-geo-code]").first().click();
      await done.click();
      await expect(bar(page, "geoblocking")).toBeVisible();
      expect(puts).toEqual([]);
    });

    test("editor footers and the config upload say Save", async ({ page }) => {
      await gotoRoute(page, origin, "routes");
      await expect(page.locator("#route-save")).toHaveText("Save");
      await expect(page.locator("#inbound-save")).toHaveText("Save");
      await expect(page.locator("#peer-save")).toHaveText("Save");
      await expect(page.locator("#config-upload-apply")).toHaveText("Save");
    });
  });

  test.describe("API token", () => {
    test("Connect reports success", async ({ page }) => {
      await gotoRoute(page, origin, "token");
      await expect(page.locator("#token-connect")).toHaveText("Connect");
      await page.locator("#token-connect").click();
      await expect(page.locator("#auth-msg")).toHaveText(/^Connected/);
      await expect(page.locator("#auth-msg")).not.toHaveClass(/err/);
    });

    test("Connect reports a rejected token", async ({ page }) => {
      await gotoRoute(page, origin, "token");
      await page.locator("#token").fill("wrong-token");
      await page.locator("#token-connect").click();
      await expect(page.locator("#auth-msg")).toHaveText(/^Could not connect/);
      await expect(page.locator("#auth-msg")).toHaveClass(/err/);
    });

    test("Connect with no token says so", async ({ page }) => {
      await gotoRoute(page, origin, "token");
      await page.locator("#token").fill("");
      await page.locator("#token-connect").click();
      await expect(page.locator("#auth-msg")).toHaveText(/Enter an API token/);
    });
  });

  test.describe("checkboxes", () => {
    test("editors use the theme checkbox, unbent by old rules", async ({ page }) => {
      await gotoRoute(page, origin, "routes");
      await page.locator("#routes-add").click();
      for (const id of ["route-f-disabled", "route-f-proto-tcp", "route-f-proto-udp"]) {
        const box = page.locator(`#${id}`);
        await expect(box).toHaveClass(/evu-checkbox/);
        await expect(box).toHaveCSS("width", "16px");
        await expect(box).toHaveCSS("border-radius", "4px");

        // The text sits beside the box: `.field label` once stacked them.
        const boxRect = (await box.boundingBox())!;
        const textRect = (await page.locator(`label:has(#${id}) .evu-check__text`).boundingBox())!;
        expect(textRect.x).toBeGreaterThan(boxRect.x + boxRect.width);
        expect(textRect.y).toBeLessThan(boxRect.y + boxRect.height);
      }
    });

    test("switches stay switches in rows, Maintenance, metrics and Geoblock", async ({ page }) => {
      await gotoRoute(page, origin, "overview");
      for (const id of [
        "overview-maintenance-toggle",
        "settings-metrics-collection",
        "settings-advanced-toggle",
        "geo-f-enabled",
        "geo-f-apply-input-allows",
        "geo-f-crowdsec-enabled",
      ]) {
        await expect(page.locator(`#${id}`)).toHaveClass(/evu-switch__input/);
      }
    });

    test("the country list uses the theme checkbox", async ({ page }) => {
      await gotoRoute(page, origin, "geoblocking");
      await page.locator("#geo-tags-edit").click();
      await expect(page.locator("#geo-modal-list input[data-geo-code]").first()).toHaveClass(/evu-checkbox/);
    });
  });
});

test.describe("save bar (axe)", () => {
  for (const scheme of SCHEMES) {
    test(`no blocking violations with the bar, an error and a checkbox form, ${scheme}`, async ({ page }) => {
      await seed(page, { scheme, advanced: true });
      await gotoRoute(page, origin, "settings");
      await page.locator("#settings-public-interface").fill("not a valid interface name");
      await barSave(page, "settings").click();
      await expect(bar(page, "settings").locator(".save-bar__error")).toBeVisible();

      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const blocking = results.violations
        .filter((v) => v.impact === "critical" || v.impact === "serious")
        .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
      expect(blocking).toEqual([]);

      await page.locator('.nav-link[data-route="routes"]').click();
      await page.locator("#confirm-modal-ok").click();
      await page.locator("#page-routes #routes-add").click();
      await expect(page.locator("#route-modal")).not.toHaveClass(/is-hidden/);
      // Let the entrance transition land: axe reads a half-faded dialog as low contrast.
      await page.waitForTimeout(400);
      const modal = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      expect(
        modal.violations
          .filter((v) => v.impact === "critical" || v.impact === "serious")
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)
      ).toEqual([]);
    });
  }
});
