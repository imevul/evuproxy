/**
 * Screenshots primary hash routes against the Docker dev UI (docker-compose.dev.yml).
 * Requires mock API reachable; TOKEN must match MOCK_API_TOKEN (default "dev").
 */
import * as fs from "fs";
import * as path from "path";

import { test } from "@playwright/test";

const ROUTES = [
  "overview",
  "settings",
  "token",
  "peers",
  "routes",
  "topology",
  "inbound",
  "geoblocking",
  "pending",
  "stats",
  "logs",
] as const;

const token = (): string =>
  process.env.API_TOKEN?.trim() || process.env.MOCK_API_TOKEN?.trim() || "dev";

test.beforeEach(async ({ page }) => {
  const tok = token();
  await page.addInitScript((t: string) => {
    localStorage.setItem("evuproxy_api_token", t);
    localStorage.setItem("evuproxy_api_base", "/api");
  }, tok);
});

function hashUrl(origin: string, route: string): string {
  const o = origin.replace(/\/+$/, "");
  return `${o}/#/${route}`;
}

test.describe("visual inspection (full-page screenshots)", () => {
  for (const route of ROUTES) {
    test(`capture ${route}`, async ({ page, baseURL }) => {
      test.skip(!baseURL, "baseURL unset");
      const origin = baseURL!;
      await page.goto(hashUrl(origin, route), { waitUntil: "domcontentloaded" });

      await page.locator(`#page-${route}`).waitFor({ state: "visible", timeout: 25_000 });

      const visualDir = path.join(process.cwd(), "test-results", "visual");
      fs.mkdirSync(visualDir, { recursive: true });
      await page.screenshot({
        path: path.join(visualDir, `${route}.png`),
        fullPage: true,
      });
    });
  }
});
