/**
 * Removes run-to-run differences from the screenshots, for measuring a visual
 * baseline (ENG-148). Off unless PW_FREEZE_CACHE names a JSON file; smoke-visual
 * then behaves as before.
 *
 * PW_FREEZE_CSS adds CSS to every page, for testing what a comparison catches.
 *
 * The first request for each API call or font goes to the network and is stored in
 * that file, and every later run replays it. The cache has to be a file, not memory:
 * the mock's byte counters keep moving, so a per-process cache would differ per run.
 */
import * as fs from "fs";

import type { Page, Route } from "@playwright/test";

const FIXED_TIME = "2026-01-15T12:00:00Z";
const FAKE_KEY = "evu-frozen-key";

interface Stored {
  status: number;
  contentType: string;
  body: string; // base64
}

type Cache = Record<string, Stored>;

const cachePath = (): string => process.env.PW_FREEZE_CACHE?.trim() || "";

function readCache(): Cache {
  try {
    return JSON.parse(fs.readFileSync(cachePath(), "utf8")) as Cache;
  } catch {
    return {};
  }
}

async function replay(route: Route): Promise<void> {
  const req = route.request();
  const key = `${req.method()} ${req.url()} ${req.postData() ?? ""}`;
  const hit = readCache()[key];
  if (hit) {
    await route.fulfill({
      status: hit.status,
      contentType: hit.contentType,
      body: Buffer.from(hit.body, "base64"),
      headers: { "access-control-allow-origin": "*" },
    });
    return;
  }
  const res = await route.fetch();
  const body = await res.body();
  // Workers are 1, so read-modify-write cannot race.
  const cache = readCache();
  cache[key] = {
    status: res.status(),
    contentType: res.headers()["content-type"] ?? "",
    body: body.toString("base64"),
  };
  fs.writeFileSync(cachePath(), JSON.stringify(cache));
  await route.fulfill({ response: res, body });
}

/** Fixed clock, replayed API and fonts, fixed peer keys. Call before page scripts run. */
export async function freeze(page: Page): Promise<void> {
  if (!cachePath()) return;
  await page.clock.setFixedTime(new Date(FIXED_TIME));
  await page.route("**/api/**", replay);
  await page.route(/fonts\.(googleapis|gstatic)\.com/, replay);
  // A deliberate regression, to measure what a given tolerance would actually catch.
  const css = process.env.PW_FREEZE_CSS;
  if (css) {
    await page.addInitScript((rules: string) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = rules;
        document.head.append(style);
      });
    }, css);
  }
  // The peer editor generates a keypair as it opens, and the keys are on screen.
  await page.addInitScript((fake: string) => {
    const subtle = globalThis.crypto.subtle;
    const generateKey = subtle.generateKey.bind(subtle);
    const exportKey = subtle.exportKey.bind(subtle);
    (subtle as any).generateKey = (alg: any, ...rest: any[]) =>
      alg?.name === "X25519"
        ? Promise.resolve({ privateKey: fake, publicKey: fake })
        : (generateKey as any)(alg, ...rest);
    (subtle as any).exportKey = (format: any, key: any) => {
      if (key !== fake) return (exportKey as any)(format, key);
      return Promise.resolve(
        format === "jwk"
          ? { d: "QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE" }
          : new Uint8Array(32).fill(66).buffer
      );
    };
  }, FAKE_KEY);
}
