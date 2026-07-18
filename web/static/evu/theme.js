/**
 * Evu Theme — color scheme (light | dark | system) + accent palette (indigo | blue)
 *
 * Applies `.dark` on <html> to match Tailwind darkMode: ['class'] apps.
 * Applies `data-evu-palette` for accent family.
 *
 * Storage: evu-color-scheme, evu-palette
 */

const SCHEME_KEY = "evu-color-scheme";
const PALETTE_KEY = "evu-palette";

/** @typedef {"light" | "dark" | "system"} EvuScheme */
/** @typedef {"indigo" | "blue"} EvuPalette */

/**
 * @returns {EvuScheme}
 */
export function getStoredScheme() {
  try {
    const v = localStorage.getItem(SCHEME_KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* ignore */
  }
  return "system";
}

/**
 * @param {EvuScheme} scheme
 */
export function setStoredScheme(scheme) {
  try {
    localStorage.setItem(SCHEME_KEY, scheme);
  } catch {
    /* ignore */
  }
}

/**
 * @returns {EvuPalette}
 */
export function getStoredPalette() {
  try {
    const v = localStorage.getItem(PALETTE_KEY);
    if (v === "indigo" || v === "blue") return v;
  } catch {
    /* ignore */
  }
  return "indigo";
}

/**
 * @param {EvuPalette} palette
 */
export function setStoredPalette(palette) {
  try {
    localStorage.setItem(PALETTE_KEY, palette);
  } catch {
    /* ignore */
  }
}

/**
 * @param {EvuScheme} [scheme]
 * @returns {"light" | "dark"}
 */
export function resolveScheme(scheme = getStoredScheme()) {
  if (scheme === "light" || scheme === "dark") return scheme;
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return "dark";
}

/**
 * @param {EvuScheme} [scheme]
 */
export function applyScheme(scheme = getStoredScheme()) {
  const resolved = resolveScheme(scheme);
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
  root.dataset.evuScheme = scheme;
  root.dataset.evuResolved = resolved;
  return resolved;
}

/**
 * @param {EvuPalette} [palette]
 */
export function applyPalette(palette = getStoredPalette()) {
  const root = document.documentElement;
  root.dataset.evuPalette = palette;
  return palette;
}

/**
 * @param {EvuScheme} scheme
 */
export function setScheme(scheme) {
  setStoredScheme(scheme);
  return applyScheme(scheme);
}

/**
 * @param {EvuPalette} palette
 */
export function setPalette(palette) {
  setStoredPalette(palette);
  return applyPalette(palette);
}

/**
 * Wire controls:
 *   [data-evu-scheme="light|dark|system"]
 *   [data-evu-palette="indigo|blue"]
 */
export function bindThemeControls(root = document) {
  applyScheme();
  applyPalette();

  const schemeButtons = root.querySelectorAll("[data-evu-scheme]");
  const syncScheme = () => {
    const current = getStoredScheme();
    schemeButtons.forEach((btn) => {
      const value = btn.getAttribute("data-evu-scheme");
      btn.setAttribute("aria-pressed", value === current ? "true" : "false");
    });
  };
  schemeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-evu-scheme");
      if (value === "light" || value === "dark" || value === "system") {
        setScheme(value);
        syncScheme();
      }
    });
  });
  syncScheme();

  // Prefer buttons — avoid matching <html data-evu-palette>
  const paletteButtons = root.querySelectorAll("button[data-evu-palette]");
  const syncPalette = () => {
    const current = getStoredPalette();
    paletteButtons.forEach((btn) => {
      const value = btn.getAttribute("data-evu-palette");
      btn.setAttribute("aria-pressed", value === current ? "true" : "false");
    });
  };
  paletteButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const value = btn.getAttribute("data-evu-palette");
      if (value === "indigo" || value === "blue") {
        setPalette(value);
        syncPalette();
      }
    });
  });
  syncPalette();

  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if (getStoredScheme() === "system") applyScheme("system");
    };
    if (mq.addEventListener) mq.addEventListener("change", onChange);
    else if (mq.addListener) mq.addListener(onChange);
  }
}

/** Inline FOUC script body (no module). Paste inside <script> in <head>. */
export function getFoucScript() {
  return `(function(){try{var r=document.documentElement;var s=localStorage.getItem('evu-color-scheme')||'system';var d=s==='dark'||(s!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches);r.classList.toggle('dark',d);r.style.colorScheme=d?'dark':'light';var p=localStorage.getItem('evu-palette');if(p==='blue'||p==='indigo')r.setAttribute('data-evu-palette',p);else r.setAttribute('data-evu-palette','indigo');}catch(e){}})();`;
}

if (typeof document !== "undefined") {
  const current = document.currentScript;
  if (current && current.hasAttribute("data-evu-autoload")) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => bindThemeControls());
    } else {
      bindThemeControls();
    }
  }
}
