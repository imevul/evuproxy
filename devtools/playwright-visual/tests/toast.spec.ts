/**
 * Toast behaviour and the save feedback built on it.
 *
 * The pause tests use a fake clock so they assert the 10 second budget rather than
 * sit through it. The action button has no caller in the app yet, so those tests
 * drive the module directly, the way a page would.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";

import { SCHEMES, gotoRoute, seed, token } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || process.env.BASE_URL?.trim() || "http://127.0.0.1:9080";
const apiHeaders = { "X-API-Token": token() };
const toast = (page: Page) => page.locator("#toaster .evu-toast");
/** The visible part of a row switch: its input is 0x0, so it cannot be clicked directly. */
const switchTrack = (scope: Locator, input: string) =>
  scope.locator(`label.evu-switch:has(${input})`).first();

async function fetchConfig(request: APIRequestContext): Promise<unknown> {
  const r = await request.get(`${origin}/api/v1/config`, { headers: apiHeaders });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

async function putConfig(request: APIRequestContext, cfg: unknown): Promise<void> {
  const r = await request.put(`${origin}/api/v1/config`, { headers: apiHeaders, data: cfg });
  expect(r.ok()).toBeTruthy();
}

/** Calls showToast from the page. `withAction` records clicks on window.__toastAction. */
async function show(page: Page, message: string, opts: { withAction?: boolean; error?: boolean } = {}): Promise<void> {
  await page.evaluate(
    async ({ message, opts }) => {
      const { showToast } = await import("/static/js/core/toast.js" as string);
      showToast(message, {
        error: !!opts.error,
        action: opts.withAction
          ? {
              label: "Undo",
              onClick: () => {
                (window as unknown as { __toastAction: boolean }).__toastAction = true;
              },
            }
          : null,
      });
    },
    { message, opts }
  );
}

test.describe("toast behaviour", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
    await page.clock.install();
  });

  test("appears in the status region and dismisses itself after about 10 seconds", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await expect(page.locator("#toaster")).toHaveAttribute("role", "status");

    await show(page, "Route saved");
    await expect(page.locator("#toaster")).toContainText("Route saved");

    await page.clock.runFor(9_000);
    await expect(toast(page)).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(toast(page)).toHaveCount(0);
  });

  test("shows one toast at a time and a new one restarts the timer", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "First");
    await page.clock.runFor(8_000);
    await show(page, "Second");
    await expect(toast(page)).toHaveCount(1);
    await expect(toast(page)).toHaveText(/Second/);

    await page.clock.runFor(8_000);
    await expect(toast(page)).toBeVisible();
  });

  test("a new toast retargets one that is already leaving", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "First");
    await toast(page).locator(".evu-toast__close").click();
    await expect(toast(page)).toHaveAttribute("data-leaving", "");

    await show(page, "Second");
    await expect(toast(page)).toHaveCount(1);
    await expect(toast(page)).not.toHaveAttribute("data-leaving", "");
    await expect(toast(page)).toHaveText(/Second/);
  });

  test("pauses while hovered", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "Hover me");
    await page.clock.runFor(5_000);
    await toast(page).hover();
    await page.clock.runFor(30_000);
    await expect(toast(page)).toBeVisible();

    // Resumes with what was left, not a fresh 10 seconds.
    await page.mouse.move(0, 0);
    await page.clock.runFor(4_000);
    await expect(toast(page)).toBeVisible();
    await page.clock.runFor(1_500);
    await expect(toast(page)).toHaveCount(0);
  });

  test("pauses while focus is inside", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "Focus me", { withAction: true });
    await toast(page).getByRole("button", { name: "Undo" }).focus();
    await page.clock.runFor(30_000);
    await expect(toast(page)).toBeVisible();
  });

  test("pauses while the tab is hidden", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "Hidden tab");
    const setHidden = (hidden: boolean) =>
      page.evaluate((h) => {
        Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);

    await setHidden(true);
    await page.clock.runFor(30_000);
    await expect(toast(page)).toBeVisible();

    await setHidden(false);
    await page.clock.runFor(10_500);
    await expect(toast(page)).toHaveCount(0);
  });

  test("the action is reachable by keyboard and focus returns afterwards", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    const add = page.locator("#routes-add");
    await add.focus();
    await show(page, "Route removed", { withAction: true });

    const action = toast(page).getByRole("button", { name: "Undo" });
    let reached = false;
    for (let i = 0; i < 80 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await action.evaluate((el) => el === document.activeElement);
    }
    expect(reached, "Tab never reached the toast action").toBe(true);

    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => (window as unknown as { __toastAction?: boolean }).__toastAction)).toBe(true);
    await expect(toast(page)).toHaveAttribute("data-leaving", "");
    await expect(action).not.toBeFocused();
    expect(await page.evaluate(() => document.activeElement === document.body)).toBe(false);
  });

  test("an error toast never dismisses itself", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await show(page, "Could not save", { error: true });
    await page.clock.runFor(120_000);
    await expect(toast(page)).toBeVisible();

    await toast(page).getByRole("button", { name: "Dismiss" }).click();
    await page.clock.runFor(1_000);
    await expect(toast(page)).toHaveCount(0);
  });
});

test.describe("save feedback", () => {
  test.beforeEach(async ({ page }) => {
    await seed(page, { scheme: "light" });
  });

  test("route switch confirms, dims the row and keeps focus on the switch", async ({ page, request }) => {
    const snapshot = await fetchConfig(request);
    try {
      await gotoRoute(page, origin, "routes");
      const row = page.locator("#routes-table-wrap tbody tr").first();
      const sw = row.locator("input[data-route-disabled]");
      await sw.focus();
      await page.keyboard.press("Space");

      await expect(toast(page)).toHaveText(/Route disabled/);
      await expect(row).toHaveClass(/is-row-disabled/);
      await expect(row.locator("input[data-route-disabled]")).toBeFocused();

      await page.keyboard.press("Space");
      await expect(toast(page)).toHaveText(/Route enabled/);
      await expect(row).not.toHaveClass(/is-row-disabled/);
    } finally {
      await putConfig(request, snapshot);
    }
  });

  test("peer and inbound switches confirm", async ({ page, request }) => {
    const snapshot = await fetchConfig(request);
    try {
      await gotoRoute(page, origin, "inbound");
      await switchTrack(page.locator("#inbound-table-wrap"), "input[data-inbound-disabled]").click();
      await expect(toast(page)).toHaveText(/Inbound rule disabled/);

      await gotoRoute(page, origin, "peers");
      await switchTrack(page.locator("#peers-table-wrap"), "input[data-peer-disabled]").click();
      // The seeded peers have routes pointing at them, so this one asks first.
      const ok = page.locator("#confirm-modal-ok");
      if (await ok.isVisible()) await ok.click();
      await expect(toast(page)).toHaveText(/Peer( and its routes)? disabled/);
    } finally {
      await putConfig(request, snapshot);
    }
  });

  test("a failed switch stays under its row and outlives a re-render", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.route("**/api/v1/config", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' })
        : route.fallback()
    );
    const row = page.locator("#routes-table-wrap tbody tr").first();
    await switchTrack(row, "input[data-route-disabled]").click();

    const err = page.locator("#routes-table-wrap tr.row-error");
    await expect(err).toHaveText(/disk full/);
    await expect(err.locator('[role="alert"]')).toHaveCount(1);
    await expect(row.locator("input[data-route-disabled]")).toBeChecked();
    await expect(toast(page)).toHaveCount(0);
    // Directly beneath the row that failed.
    await expect(row.locator("+ tr")).toHaveClass(/row-error/);
  });

  test("a failed editor save shows inside the dialog and leaves it open", async ({ page }) => {
    await gotoRoute(page, origin, "routes");
    await page.route("**/api/v1/config", (route) =>
      route.request().method() === "PUT"
        ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"disk full"}' })
        : route.fallback()
    );
    await page.locator("#routes-table-wrap [data-route-edit]").first().click();
    await page.locator("#route-save").click();

    const msg = page.locator("#route-modal #route-editor-msg");
    await expect(msg).toBeVisible();
    await expect(msg).toHaveText(/disk full/);
    await expect(page.locator("#route-modal")).not.toHaveClass(/is-hidden/);
    await expect(toast(page)).toHaveCount(0);
  });

  test("browser-only settings do not toast", async ({ page }) => {
    await gotoRoute(page, origin, "settings");
    await page.locator("#settings-tab-adv-btn").click();
    const width = page.locator("#settings-content-width");
    const before = await width.inputValue();
    await width.selectOption({ index: before === "small" ? 1 : 0 });
    await expect(width).not.toHaveValue(before);
    await page.waitForTimeout(300);
    await expect(toast(page)).toHaveCount(0);
  });
});

test.describe("toast and dimmed rows (axe)", () => {
  for (const scheme of SCHEMES) {
    test(`no blocking violations ${scheme}`, async ({ page, request }) => {
      const snapshot = await fetchConfig(request);
      try {
        await seed(page, { scheme });
        await gotoRoute(page, origin, "peers");
        await switchTrack(page.locator("#peers-table-wrap"), "input[data-peer-disabled]").click();
        const ok = page.locator("#confirm-modal-ok");
        if (await ok.isVisible()) await ok.click();
        await expect(toast(page)).toBeVisible();
        await show(page, "Peer disabled", { withAction: true });
        // Let the entrance transition land: axe reads a half-faded toast as low contrast.
        await page.waitForTimeout(400);

        const results = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        const blocking = results.violations
          .filter((v) => v.impact === "critical" || v.impact === "serious")
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
        expect(blocking).toEqual([]);
      } finally {
        await putConfig(request, snapshot);
      }
    });
  }
});
