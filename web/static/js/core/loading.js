import { $ } from "./dom.js";

/* A response inside this window shows no visual change, so a fast link never flashes. */
const loadingVisualDelayMs = 300;

/** @type {WeakMap<HTMLElement, { count: number, timer: ReturnType<typeof setTimeout> | null, skeleton: HTMLElement | null }>} */
const regions = new WeakMap();

function buildSkeleton() {
  // Spans, not divs: a region can be phrasing-only, and aria-hidden because
  // aria-busy on the region already tells assistive tech what this means.
  const skeleton = document.createElement("span");
  skeleton.className = "loading-skeleton";
  skeleton.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i++) {
    const row = document.createElement("span");
    row.className = "loading-skeleton__row";
    skeleton.appendChild(row);
  }
  return skeleton;
}

function showLoadingVisual(el, entry) {
  entry.timer = null;
  if (el.textContent.trim()) {
    el.classList.add("is-loading");
    return;
  }
  entry.skeleton = buildSkeleton();
  el.appendChild(entry.skeleton);
}

function beginRegion(el) {
  let entry = regions.get(el);
  if (!entry) {
    entry = { count: 0, timer: null, skeleton: null };
    regions.set(el, entry);
  }
  entry.count++;
  if (entry.count > 1) return;
  el.setAttribute("aria-busy", "true");
  entry.timer = setTimeout(() => showLoadingVisual(el, entry), loadingVisualDelayMs);
}

function endRegion(el) {
  const entry = regions.get(el);
  entry.count--;
  if (entry.count > 0) return;
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entry.skeleton) entry.skeleton.remove();
  entry.skeleton = null;
  el.classList.remove("is-loading");
  el.removeAttribute("aria-busy");
}

/**
 * Marks regions (by element id) as loading: aria-busy at once, then after a short
 * delay old content dims, or an empty region gets a skeleton. Overlapping loads of
 * one region nest, so it stays busy until the last one finishes.
 *
 * @param {...string} ids
 * @returns {() => void} call once when the load finishes, success or not
 */
export function beginLoading(...ids) {
  const els = ids.map((id) => $(id)).filter(Boolean);
  els.forEach(beginRegion);
  return () => els.forEach(endRegion);
}
