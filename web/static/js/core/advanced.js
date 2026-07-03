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
  geo: "Enable Advanced mode in Settings to edit nftables set name, zone directory, break-glass CIDRs, and rate limits.",
};

function setTabGatedState(btn, hintEl, gated, tooltipText, ariaLabelWhenGated) {
  if (!btn) return;
  const tablist = btn.closest('[role="tablist"]');
  btn.classList.toggle("is-disabled", gated);
  if (gated) {
    btn.setAttribute("aria-disabled", "true");
    btn.setAttribute("tabindex", "-1");
    btn.setAttribute("title", tooltipText);
    btn.setAttribute("aria-label", ariaLabelWhenGated);
  } else {
    btn.removeAttribute("aria-disabled");
    btn.removeAttribute("tabindex");
    btn.removeAttribute("title");
    btn.removeAttribute("aria-label");
  }
  if (hintEl) hintEl.hidden = !gated;
  if (tablist) {
    const enabled = tablist.querySelectorAll('[role="tab"]:not([aria-disabled="true"])');
    tablist.classList.toggle("geo-segmented--single-enabled", enabled.length === 1);
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
  if (!on) {
    setRouteEditorTab("default");
    setGeoEditorTab("default");
  }
}

export function setGeoEditorTab(which) {
  if (which === "advanced" && !advancedSettingsEnabled()) return;
  const advanced = which === "advanced";
  const defaultBtn = $("geo-tab-default-btn");
  const advBtn = $("geo-tab-advanced-btn");
  const defaultPanel = $("geo-tab-default-panel");
  const advPanel = $("geo-tab-advanced-panel");
  if (!defaultBtn || !advBtn || !defaultPanel || !advPanel) return;
  defaultBtn.classList.toggle("is-active", !advanced);
  advBtn.classList.toggle("is-active", advanced);
  defaultBtn.setAttribute("aria-selected", advanced ? "false" : "true");
  advBtn.setAttribute("aria-selected", advanced ? "true" : "false");
  defaultPanel.hidden = advanced;
  advPanel.hidden = !advanced;
}

export function setRouteEditorTab(which) {
  if (which === "advanced" && !advancedSettingsEnabled()) return;
  const advanced = which === "advanced";
  const defaultBtn = $("route-tab-default-btn");
  const advBtn = $("route-tab-advanced-btn");
  const defaultPanel = $("route-tab-default-panel");
  const advPanel = $("route-tab-advanced-panel");
  if (!defaultBtn || !advBtn || !defaultPanel || !advPanel) return;
  defaultBtn.classList.toggle("is-active", !advanced);
  advBtn.classList.toggle("is-active", advanced);
  defaultBtn.setAttribute("aria-selected", advanced ? "false" : "true");
  advBtn.setAttribute("aria-selected", advanced ? "true" : "false");
  defaultPanel.hidden = advanced;
  advPanel.hidden = !advanced;
}
