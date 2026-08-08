import { advancedSettingsKey } from "./state.js";
import { $ } from "./dom.js";

export function advancedSettingsEnabled() {
  try {
    return localStorage.getItem(advancedSettingsKey) === "1";
  } catch (e) {
    return false;
  }
}

export function setAdvancedSettingsEnabled(on) {
  try {
    if (on) localStorage.setItem(advancedSettingsKey, "1");
    else localStorage.removeItem(advancedSettingsKey);
  } catch (e) {
    /* ignore */
  }
  syncAdvancedSettingsToggle();
  syncAdvancedTabsGating();
}

export function syncAdvancedSettingsToggle() {
  const cb = $("settings-advanced-toggle");
  if (!cb) return;
  cb.checked = advancedSettingsEnabled();
}

const advancedTabGatedTooltips = {
  route:
    "Enable Advanced mode in Settings to edit source allow/deny lists, port mapping, and per-route geo overrides.",
  geo: "Enable Advanced mode in Settings to edit the global denylist, nftables set name, zone directory, break-glass CIDRs, rate limits and CrowdSec.",
};

function setTabGatedState(btn, hintEl, gated, tooltipText, ariaLabelWhenGated) {
  if (!btn) return;
  const tablist = btn.closest('[role="tablist"]');
  btn.classList.toggle("is-disabled", gated);
  // tabindex is deliberately not touched here: tabs.js owns the single tab stop
  // per tablist and re-syncs it off the aria-disabled change below. Removing the
  // attribute here would restore the browser default of 0 and leave the list with
  // two tab stops, which is the thing that helper exists to prevent.
  if (gated) {
    btn.setAttribute("aria-disabled", "true");
    btn.setAttribute("title", tooltipText);
    btn.setAttribute("aria-label", ariaLabelWhenGated);
  } else {
    btn.removeAttribute("aria-disabled");
    btn.removeAttribute("title");
    btn.removeAttribute("aria-label");
  }
  if (hintEl) hintEl.hidden = !gated;
  if (tablist) {
    const enabled = tablist.querySelectorAll('[role="tab"]:not([aria-disabled="true"])');
    tablist.classList.toggle("section-tabs--single-enabled", enabled.length === 1);
  }
}

/** Disable Routes / Geoblocking Advanced tabs unless Settings → Advanced mode is on. */
export function syncAdvancedTabsGating() {
  const on = advancedSettingsEnabled();
  setTabGatedState(
    $("route-tab-advanced-btn"),
    $("route-tabs-gated-hint"),
    !on,
    advancedTabGatedTooltips.route,
    "Advanced, disabled. Enable Advanced mode in Settings."
  );
  setTabGatedState(
    $("geo-tab-advanced-btn"),
    $("geo-tabs-gated-hint"),
    !on,
    advancedTabGatedTooltips.geo,
    "Advanced, disabled. Enable Advanced mode in Settings."
  );
  // Only move off the tab that just became unreachable; other selections stand.
  if (!on) {
    if (isTabSelected("route", "advanced")) setRouteEditorTab("default");
    if (isTabSelected("geo", "advanced")) setGeoEditorTab("default");
  }
}

function isTabSelected(prefix, name) {
  const btn = $(`${prefix}-tab-${name}-btn`);
  return !!btn && btn.getAttribute("aria-selected") === "true";
}

/**
 * Selects one tab in a `<prefix>-tab-<name>-btn` / `-panel` group.
 * Missing tabs are ignored so a page can add or drop one without changing this.
 */
function selectEditorTab(prefix, names, which) {
  const parts = names
    .map((name) => ({
      name,
      btn: $(`${prefix}-tab-${name}-btn`),
      panel: $(`${prefix}-tab-${name}-panel`),
    }))
    .filter((t) => t.btn && t.panel);
  if (!parts.some((t) => t.name === which)) return;
  for (const t of parts) {
    const on = t.name === which;
    t.btn.classList.toggle("is-active", on);
    t.btn.setAttribute("aria-selected", on ? "true" : "false");
    t.panel.hidden = !on;
  }
}

export function setGeoEditorTab(which) {
  if (which === "advanced" && !advancedSettingsEnabled()) return;
  selectEditorTab("geo", ["default", "advanced", "zones"], which);
}

export function setRouteEditorTab(which) {
  if (which === "advanced" && !advancedSettingsEnabled()) return;
  selectEditorTab("route", ["default", "advanced"], which);
}
