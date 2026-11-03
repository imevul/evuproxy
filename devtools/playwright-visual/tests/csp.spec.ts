/**
 * Content-Security-Policy on the dev stack (ENG-163). tests/fixtures.ts fails any spec
 * on a violation; this one checks the policy itself, that it really refuses things, and
 * the features that lean on an allowed source.
 */
import { test as plain, type ConsoleMessage, type Page } from "@playwright/test";

import { expect, isCspViolation, test } from "./fixtures";
import { gotoRoute, ROUTES, seed } from "./helpers";

const origin = process.env.PW_BASE_URL?.trim() || "http://127.0.0.1:9080";

/** Records violations for the tests that expect some, which use the plain `test`. */
function collectViolations(page: Page): string[] {
  const seen: string[] = [];
  page.on("console", (msg: ConsoleMessage) => {
    if (isCspViolation(msg.text())) seen.push(msg.text());
  });
  return seen;
}

test("the policy is strict and sent with the UI, static files, the API and errors", async ({ request }) => {
  for (const path of ["/", "/static/js/main.js", "/static/does-not-exist.js", "/api/v1/status"]) {
    const res = await request.get(origin + path);
    const csp = res.headers()["content-security-policy"] ?? "";
    expect(csp, path).toContain("default-src 'none'");
    expect(csp, path).toContain("script-src 'self';");
    expect(csp, path).toContain("frame-ancestors 'none'");
    expect(csp, path).not.toContain("unsafe");
  }
});

test("index.html has no inline script, style or event handler", async ({ request }) => {
  const html = await (await request.get(origin + "/")).text();
  expect(html.match(/<script(?![^>]*\ssrc=)[^>]*>/g)).toBeNull();
  expect(html.match(/<style[\s>]/g)).toBeNull();
  expect(html.match(/<[a-z][^>]*\s(style|on[a-z]+)=/gi)).toBeNull();
});

test("every route loads without a violation", async ({ page }) => {
  await seed(page, { scheme: "dark" });
  for (const route of ROUTES) await gotoRoute(page, origin, route);
});

test("the theme is on <html> from the guard alone, before any other script", async ({ page }) => {
  await seed(page, { scheme: "dark" });
  await page.addInitScript(() => localStorage.setItem("evu-palette", "blue"));
  // Everything else that sets the theme, so only the guard can have done it.
  await page.route(/theme-autoload\.js|js\/main\.js/, (route) => route.abort());
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  const html = page.locator("html");
  await expect(html).toHaveClass(/\bdark\b/);
  await expect(html).toHaveAttribute("data-evu-palette", "blue");
  await expect.poll(() => html.evaluate((el) => el.style.colorScheme)).toBe("dark");
});

test("a peer QR code still displays from its blob: URL", async ({ page }) => {
  // The UI POSTs for the code, and the mock only answers GET.
  await page.route("**/api/v1/peers/*/qr.png", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==",
        "base64"
      ),
    })
  );
  await seed(page, { scheme: "light" });
  await gotoRoute(page, origin, "peers");
  await page.locator("#peers-table-wrap tbody tr button", { hasText: /edit/i }).first().click();
  await page.locator("#peer-tab-onboard-btn").click();
  // What "Build" leaves here. A saved peer has no private key to build from.
  await page.locator("#onboard-out").evaluate((el) => {
    el.textContent = "[Interface]\nAddress = 10.100.0.2/32\n";
  });
  await page.locator("#onboard-show-qr").click();
  const img = page.locator("#peer-qr-canvas-wrap img");
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
});

plain("injected inline script and style are refused, and the fixture would see it", async ({ page }) => {
  const violations = collectViolations(page);
  await page.route(`${origin}/`, async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace(
      "</head>",
      '<script>window.__injected = true;</script><style>body { display: none; }</style></head>'
    );
    await route.fulfill({ response: res, body });
  });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  expect(await page.evaluate(() => (window as any).__injected === true)).toBe(false);
  await expect(page.locator("body")).not.toHaveCSS("display", "none");
  await expect.poll(() => violations.length).toBeGreaterThanOrEqual(2);
});

plain("fetch reaches the release check but no other origin", async ({ page }) => {
  const violations = collectViolations(page);
  // Fulfilled here, so neither call needs the network: only the policy can refuse them.
  await page.route(/^https:\/\/(api\.github\.com|evil\.example)\//, (route) =>
    route.fulfill({ json: {}, headers: { "access-control-allow-origin": "*" } })
  );
  await seed(page, { scheme: "light" });
  await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
  const reach = (url: string) =>
    page.evaluate(
      (u) =>
        fetch(u).then(
          () => "ok",
          () => "refused"
        ),
      url
    );
  expect(await reach("https://api.github.com/repos/imevul/evuproxy/releases/latest")).toBe("ok");
  expect(violations).toEqual([]);
  expect(await reach("https://evil.example/steal")).toBe("refused");
  await expect.poll(() => violations.join("\n")).toContain("evil.example");
});
