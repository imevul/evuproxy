#!/usr/bin/env node
/**
 * Compares screenshot sets of the same code, using the comparator behind Playwright's
 * toHaveScreenshot. The first set stands in for the baseline; each other set is compared
 * to it, as CI would compare a run. (ENG-148)
 *
 *     node measure-flake.mjs [--threshold=0.2] [--tolerance=N] [--json] screenshots/run-1 screenshots/run-2 ...
 *
 * `exact` counts pixels that differ at all, and `pm` counts those over the threshold,
 * by default Playwright's 0.2. A set fails if any image changes size or has pm > tolerance.
 * Exits 0 regardless: this reports numbers and gates nothing.
 */
import { readdirSync, readFileSync, existsSync } from "fs";
import { createRequire } from "module";
import { join } from "path";

const require = createRequire(import.meta.url);
const { PNG } = require("playwright-core/lib/utilsBundle");
const { getComparator } = require("playwright-core/lib/coreBundle").utils ?? require("playwright-core/lib/coreBundle");
const compareImages = getComparator("image/png");

const args = process.argv.slice(2);
const tolerance = Number(args.find((a) => a.startsWith("--tolerance="))?.split("=")[1] ?? 0);
const threshold = Number(args.find((a) => a.startsWith("--threshold="))?.split("=")[1] ?? 0.2);
const asJson = args.includes("--json");
const sets = args.filter((a) => !a.startsWith("--"));
if (sets.length < 2) {
  console.error("usage: measure-flake.mjs [--tolerance=N] [--json] <base> <other> ...");
  process.exit(2);
}

function exactDiff(a, b) {
  let px = 0;
  let maxDelta = 0;
  const box = { x0: Infinity, y0: Infinity, x1: -1, y1: -1 };
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2])
    );
    if (delta > 0) {
      px += 1;
      const x = (i / 4) % a.width;
      const y = Math.floor(i / 4 / a.width);
      box.x0 = Math.min(box.x0, x);
      box.y0 = Math.min(box.y0, y);
      box.x1 = Math.max(box.x1, x);
      box.y1 = Math.max(box.y1, y);
    }
    if (delta > maxDelta) maxDelta = delta;
  }
  return { px, maxDelta, box };
}

function compareOne(aPath, bPath) {
  const aBuf = readFileSync(aPath);
  const bBuf = readFileSync(bPath);
  const a = PNG.sync.read(aBuf);
  const b = PNG.sync.read(bBuf);
  if (a.width !== b.width || a.height !== b.height) {
    return { resized: `${a.width}x${a.height} -> ${b.width}x${b.height}`, exact: Infinity, pm: Infinity };
  }
  const { px, maxDelta, box } = exactDiff(a, b);
  if (px === 0) return { exact: 0, maxDelta: 0, pm: 0, total: a.width * a.height };
  const res = compareImages(bBuf, aBuf, { threshold });
  const pm = res ? Number(/(\d+) pixels/.exec(res.errorMessage)?.[1] ?? 0) : 0;
  return { exact: px, maxDelta, pm, box, total: a.width * a.height };
}

const base = sets[0];
const names = readdirSync(base).filter((f) => f.endsWith(".png")).sort();
const perImage = Object.fromEntries(names.map((n) => [n, { differedIn: 0, maxExact: 0, maxDelta: 0, maxPm: 0, resized: 0 }]));
const perSet = [];

for (const set of sets.slice(1)) {
  let identical = 0;
  let failed = 0;
  let missing = 0;
  for (const name of names) {
    const other = join(set, name);
    if (!existsSync(other)) {
      missing += 1;
      failed += 1;
      continue;
    }
    const r = compareOne(join(base, name), other);
    const s = perImage[name];
    if (r.resized) s.resized += 1;
    if (r.exact > 0) s.differedIn += 1;
    else identical += 1;
    if (r.exact !== Infinity) {
      s.maxExact = Math.max(s.maxExact, r.exact);
      s.maxDelta = Math.max(s.maxDelta, r.maxDelta);
      if (r.pm >= s.maxPm && r.box) s.box = r.box;
      s.maxPm = Math.max(s.maxPm, r.pm);
      s.total = r.total;
    }
    if (r.resized || r.pm > tolerance) failed += 1;
  }
  perSet.push({ set, identical, failed, missing, images: names.length });
}

const noisy = Object.entries(perImage)
  .filter(([, s]) => s.differedIn > 0)
  .sort((a, b) => b[1].maxPm - a[1].maxPm || b[1].maxExact - a[1].maxExact);

if (asJson) {
  console.log(JSON.stringify({ base, tolerance, perSet, noisy: Object.fromEntries(noisy) }, null, 2));
} else {
  console.log(`base ${base}, ${names.length} images, tolerance ${tolerance} px over threshold ${threshold}\n`);
  for (const r of perSet) {
    console.log(`${r.failed === 0 ? "pass" : "FAIL"}  ${r.set}: ${r.identical}/${r.images} identical, ${r.failed} over tolerance, ${r.missing} missing`);
  }
  console.log(`\nsets passing: ${perSet.filter((r) => r.failed === 0).length}/${perSet.length}`);
  console.log(`images that ever differed: ${noisy.length}/${names.length}`);
  for (const [name, s] of noisy) {
    const pct = s.total ? ((s.maxExact / s.total) * 100).toFixed(3) : "n/a";
    console.log(`  ${name}: in ${s.differedIn}/${perSet.length} sets, max exact ${s.maxExact} px (${pct}%), max channel delta ${s.maxDelta}, max pm ${s.maxPm}${s.box ? `, box ${s.box.x0},${s.box.y0}-${s.box.x1},${s.box.y1}` : ""}${s.resized ? `, resized ${s.resized}x` : ""}`);
  }
}
