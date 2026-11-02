#!/usr/bin/env node
/**
 * Captures frozen screenshots and compares them with baseline/, using the comparator
 * behind Playwright's toHaveScreenshot at the settings decided on ENG-148. (ENG-188)
 * Runs inside the container from docker-compose.visual.yml, through `make visual-check`
 * and `make visual-baseline`.
 *
 *     visual-baseline.mjs check    captures, fails on any difference or cache miss
 *     visual-baseline.mjs update   refreshes the cache, then rewrites only the changed images
 */
import { spawnSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createRequire } from "module";
import { join, resolve } from "path";

const require = createRequire(import.meta.url);
const { getComparator } = require("playwright-core/lib/coreBundle").utils ?? require("playwright-core/lib/coreBundle");
const compareImages = getComparator("image/png");

const THRESHOLD = 0.02;
const ORIGIN = "http://127.0.0.1:8080";
const BASELINE_DIR = "baseline";
const CACHE = resolve(BASELINE_DIR, "freeze-cache.json");
const CURRENT_SUBDIR = "visual-current";
const CURRENT_DIR = join("screenshots", CURRENT_SUBDIR);
const DIFF_DIR = join("screenshots", "visual-diff");

const pngs = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".png")).sort() : []);

/** Goes through the UI's nginx to the mock API, so it covers both containers (ENG-187). */
async function waitForStack() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const res = await fetch(`${ORIGIN}/api/v1/status`, { headers: { Authorization: "Bearer dev" } });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`mock stack not answering at ${ORIGIN}`);
}

/** Returns whether every test passed. A run that fails is still compared, for the images it did take. */
function capture(env = {}) {
  rmSync(CURRENT_DIR, { recursive: true, force: true });
  const res = spawnSync(
    "npx",
    ["playwright", "test", "tests/smoke-visual.spec", "--config", "playwright.freeze.config.ts"],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        BASE_URL: ORIGIN,
        PW_BASE_URL: ORIGIN,
        PW_FREEZE_CACHE: CACHE,
        PW_VISUAL_SUBDIR: CURRENT_SUBDIR,
        ...env,
      },
    }
  );
  return res.status === 0;
}

/** Null when the images match within THRESHOLD and tolerance 0, else the comparator's result. */
function compareOne(name) {
  return compareImages(readFileSync(join(CURRENT_DIR, name)), readFileSync(join(BASELINE_DIR, name)), {
    threshold: THRESHOLD,
    maxDiffPixels: 0,
  });
}

function check() {
  rmSync(DIFF_DIR, { recursive: true, force: true });
  const captured = capture();
  const current = pngs(CURRENT_DIR);
  const baseline = pngs(BASELINE_DIR);
  const problems = [];

  for (const name of baseline.filter((n) => !current.includes(n))) problems.push(`${name}: not captured`);
  for (const name of current.filter((n) => !baseline.includes(n))) {
    problems.push(`${name}: not in the baseline`);
    mkdirSync(DIFF_DIR, { recursive: true });
    copyFileSync(join(CURRENT_DIR, name), join(DIFF_DIR, name.replace(/\.png$/, "-actual.png")));
  }
  for (const name of current.filter((n) => baseline.includes(n))) {
    const res = compareOne(name);
    if (!res) continue;
    problems.push(`${name}: ${res.errorMessage}`);
    const stem = name.replace(/\.png$/, "");
    mkdirSync(DIFF_DIR, { recursive: true });
    copyFileSync(join(CURRENT_DIR, name), join(DIFF_DIR, `${stem}-actual.png`));
    copyFileSync(join(BASELINE_DIR, name), join(DIFF_DIR, `${stem}-expected.png`));
    if (res.diff) writeFileSync(join(DIFF_DIR, `${stem}-diff.png`), res.diff);
  }

  console.log(`\nCompared ${current.length} captures with ${baseline.length} baseline images at threshold ${THRESHOLD}, tolerance 0.`);
  for (const problem of problems) console.log(`  ${problem}`);
  if (problems.length > 0) {
    console.log(`\n${problems.length} images differ. Actual, expected and diff images: ${DIFF_DIR}/`);
    console.log("If the change is intended, run `make visual-baseline` and commit the result.");
  }
  if (!captured) console.log("\nThe capture itself failed, see the test output above.");
  return captured && problems.length === 0;
}

function update() {
  mkdirSync(BASELINE_DIR, { recursive: true });
  rmSync(CACHE, { force: true });
  console.log("Recording a new replay cache from the mock stack.");
  if (!capture({ PW_FREEZE_RECORD: "1" })) return false;
  // The images to keep come from a replay, as CI's do. A request that only shows up in
  // this pass fails it here, instead of in CI after the baseline is committed.
  console.log("\nCapturing from the new cache.");
  if (!capture()) return false;

  const current = pngs(CURRENT_DIR);
  const baseline = pngs(BASELINE_DIR);
  let written = 0;
  for (const name of current) {
    // Unchanged images keep their bytes, so a re-approval only adds the ones that changed.
    if (baseline.includes(name) && !compareOne(name)) continue;
    copyFileSync(join(CURRENT_DIR, name), join(BASELINE_DIR, name));
    console.log(`  ${baseline.includes(name) ? "changed" : "new"}: ${name}`);
    written += 1;
  }
  const removed = baseline.filter((n) => !current.includes(n));
  for (const name of removed) {
    rmSync(join(BASELINE_DIR, name));
    console.log(`  removed: ${name}`);
  }
  console.log(`\nBaseline: ${current.length} images, ${written} written, ${removed.length} removed. Review them with git diff before committing.`);
  return true;
}

const mode = process.argv[2];
if (mode !== "check" && mode !== "update") {
  console.error("usage: visual-baseline.mjs check|update");
  process.exit(2);
}
await waitForStack();
process.exit((mode === "check" ? check() : update()) ? 0 : 1);
