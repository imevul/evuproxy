/**
 * Shared setup for the visual and accessibility specs.
 *
 * Both suites drive the Docker dev UI (docker-compose.dev.yml) and need the same
 * seeded localStorage: mock API token, API base, and an explicit colour scheme so
 * headless Chromium does not silently resolve "system" to light.
 */
import * as fs from "fs";
import * as path from "path";

import type { Page } from "@playwright/test";

import { freeze } from "./freeze";

export const ROUTES = [
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

export type Route = (typeof ROUTES)[number];

export const SCHEMES = ["light", "dark"] as const;

export type Scheme = (typeof SCHEMES)[number];

export const token = (): string =>
  process.env.API_TOKEN?.trim() || process.env.MOCK_API_TOKEN?.trim() || "dev";

/** Single path segment under test-results/ — stray env cannot escape tree. */
export function visualSubdirName(): string {
  const raw = process.env.PW_VISUAL_SUBDIR?.trim();
  const d = raw && raw.length > 0 ? raw : "visual";
  return /^[\w.-]+$/.test(d) && d !== "." && d !== ".." ? d : "visual";
}

/**
 * Captures live under screenshots/, never test-results/ — Playwright wipes its own
 * output directory at the start of every run, which would delete a saved baseline
 * the next time any spec is executed.
 */
export function visualDir(): string {
  const dir = path.join(process.cwd(), "screenshots", visualSubdirName());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SeedOptions {
  scheme: Scheme;
  /** Unlocks the gated Advanced tabs on the route editor and geoblocking. */
  advanced?: boolean;
}

/**
 * Runs before any page script, so the FOUC guard (static/js/theme-boot.js) already sees the
 * chosen scheme and no theme flash is captured.
 */
export async function seed(page: Page, opts: SeedOptions): Promise<void> {
  await freeze(page);
  await page.addInitScript(
    (args: { tok: string; scheme: string; advanced: boolean }) => {
      localStorage.setItem("evuproxy_api_token", args.tok);
      localStorage.setItem("evuproxy_api_base", "/api");
      localStorage.setItem("evu-color-scheme", args.scheme);
      if (args.advanced) localStorage.setItem("evuproxy_advanced_settings", "1");
      else localStorage.removeItem("evuproxy_advanced_settings");
      // Pre-seed the release cache so the sidebar never reaches api.github.com:
      // whether that call succeeds decides if the update note renders, which
      // otherwise makes every sidebar (and so every full-page shot) flaky.
      sessionStorage.setItem(
        "evuproxy_gh_release_check_v1",
        JSON.stringify({ t: Date.now(), tag: "v0.0.0" })
      );
    },
    { tok: token(), scheme: opts.scheme, advanced: !!opts.advanced }
  );
  await page.emulateMedia({ colorScheme: opts.scheme });
}

/**
 * The size that was unusable before ENG-144, on top of a real mock config: 40 peers,
 * 31 routes on the first ten of them (every third route named), 30 inbound rules.
 */
export function largeConfig(base: any) {
  const peers = Array.from({ length: 40 }, (_, i) => ({
    name: `peer-${String(i + 1).padStart(2, "0")}`,
    public_key: `${String(i + 1).padStart(2, "0")}${"A".repeat(41)}=`,
    tunnel_ip: `10.100.0.${i + 2}/32`,
  }));
  const routes = Array.from({ length: 31 }, (_, i) => ({
    ...(i % 3 === 0 ? { name: `service-${String(31 - i).padStart(2, "0")}` } : {}),
    proto: i % 2 ? "udp" : "tcp",
    // Descending and of mixed width, so a text sort and a numeric sort disagree.
    ports: [String(30000 - i * 900)],
    target_ip: `10.100.0.${(i % 10) + 2}`,
    disabled: false,
  }));
  const inputAllows = Array.from({ length: 30 }, (_, i) => ({
    proto: "tcp",
    dport: String(9000 - i * 100),
    note: `rule ${i}`,
  }));
  return {
    ...base,
    peers,
    input_allows: inputAllows,
    forwarding: { ...base.forwarding, routes },
    geo: { ...base.geo, enabled: false },
  };
}

export function hashUrl(origin: string, route: string): string {
  const o = origin.replace(/\/+$/, "");
  return `${o}/#/${route}`;
}

/** Navigates to a hash route and waits for its section to be visible. */
export async function gotoRoute(page: Page, origin: string, route: Route): Promise<void> {
  await page.goto(hashUrl(origin, route), { waitUntil: "domcontentloaded" });
  await page.locator(`#page-${route}`).waitFor({ state: "visible", timeout: 25_000 });
  // Tables and cards fill in from the mock API after first paint.
  await page.waitForLoadState("networkidle").catch(() => undefined);
}

export async function capture(page: Page, name: string): Promise<void> {
  // Dialogs focus their first field in requestAnimationFrame, so let queued frames run;
  // otherwise the focus ring is sometimes missing from the shot.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  // Without this, a shot taken right after a click can land mid-transition —
  // e.g. the tab underline still fading off the tab you just left.
  await page.screenshot({
    path: path.join(visualDir(), `${name}.png`),
    fullPage: true,
    animations: "disabled",
  });
}
