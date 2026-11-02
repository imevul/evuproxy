/**
 * Removes run-to-run differences from the screenshots, for the visual baseline
 * (ENG-148, ENG-188). Off unless PW_FREEZE_CACHE names a JSON file; smoke-visual
 * then behaves as before.
 *
 * PW_FREEZE_CSS adds CSS to every page, for testing what a comparison catches.
 *
 * API calls and fonts are replayed from that file. With PW_FREEZE_RECORD=1, a request
 * that isn't in the file goes to the network and is stored; otherwise it is blocked and
 * fails the test (see assertNoCacheMisses), because live data would bring the flakiness
 * back. The cache has to be a file, not memory: the mock's byte counters keep moving,
 * so a per-process cache would differ per run.
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

const misses = new Set<string>();

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
  if (process.env.PW_FREEZE_RECORD !== "1") {
    misses.add(key);
    await route.abort();
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
  // One sorted entry per line, so a refreshed cache shows which keys changed in review.
  const lines = Object.keys(cache)
    .sort()
    .map((k) => `${JSON.stringify(k)}: ${JSON.stringify(cache[k])}`);
  fs.writeFileSync(cachePath(), `{\n${lines.join(",\n")}\n}\n`);
  await route.fulfill({ response: res, body });
}

/** Fails the current test if it asked for anything the cache doesn't have, naming each key. */
export function assertNoCacheMisses(): void {
  if (misses.size === 0) return;
  const keys = [...misses].map((k) => `  ${k}`).join("\n");
  misses.clear();
  throw new Error(
    `Requests missing from the replay cache, blocked instead of fetched:\n${keys}\n` +
      "If this API change is intended, regenerate with `make visual-baseline`."
  );
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
