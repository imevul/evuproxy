import { state } from "../core/state.js";
import {
  $,
  escapeHtml,
  setApiStatus,
  clientIPSourceLabel,
  writeRateLimitFields,
  readRateLimitFromForm,
} from "../core/dom.js";
import { api } from "../core/api.js";
import { parseSourceAllowListInput } from "../core/net.js";
import { setGeoEditorTab, syncAdvancedTabsGating } from "../core/advanced.js";
import { openModal, closeModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

async function refreshGeoZonesTable() {
  const wrap = $("geo-zones-table-wrap");
  const msg = $("geo-zones-msg");
  if (!wrap || !msg) return;
  msg.textContent = "";
  msg.classList.remove("err");
  try {
    const s = await api("/v1/geo/summary");
    if (!s.enabled) {
      wrap.innerHTML = "<p class=\"hint meta\">Geoblocking is off in config.</p>";
      return;
    }
    const rows = (s.countries || [])
      .map((c) => {
        const miss = c.zone_missing ? " <span class=\"meta\">(zone file missing)</span>" : "";
        const codeRaw = String(c.code || "").trim();
        const fl = countryFlagEmoji(codeRaw);
        // aria-hidden: the name and the code follow it in the same cell.
        const flagHtml = fl ? '<span class="logs-ip-flag" aria-hidden="true">' + fl + "</span> " : "";
        const code = codeRaw.toUpperCase();
        const name = geoCountryName(codeRaw);
        // The name falls back to the code when the catalog failed to load.
        const codeHtml = name === code ? "" : ' <span class="meta mono">' + escapeHtml(code) + "</span>";
        return (
          "<tr><td class=\"geo-zones-col-country\">" +
          flagHtml +
          escapeHtml(name) +
          codeHtml +
          "</td><td>" +
          escapeHtml(String(c.cidr_lines)) +
          "</td><td>" +
          escapeHtml(String(c.approx_ipv4_addresses)) +
          "</td><td>" +
          (c.zone_read_error ? escapeHtml(c.zone_read_error) : "—") +
          miss +
          "</td></tr>"
        );
      })
      .join("");
    let foot = "";
    if (s.nft_set_elem_count != null) {
      foot =
        "<p class=\"hint meta\">Merged <code class=\"inline\">inet</code> set element count: " +
        escapeHtml(String(s.nft_set_elem_count)) +
        (s.nft_set_count_source ? " (" + escapeHtml(s.nft_set_count_source) + ")" : "") +
        "</p>";
    }
    wrap.innerHTML =
      "<table class=\"data\"><thead><tr><th scope=\"col\">Country</th><th scope=\"col\">CIDR lines</th><th scope=\"col\">Approx. IPv4</th><th scope=\"col\">Note</th></tr></thead><tbody>" +
      rows +
      "</tbody></table>" +
      foot;
  } catch (e) {
    msg.textContent = String(e.message || e);
    msg.classList.add("err");
    wrap.innerHTML = "";
  }
}

function geoblockingFormSnapshotForCompare() {
  return {
    enabled: !!($("geo-f-enabled") && $("geo-f-enabled").checked),
    mode: getGeoListMode(),
    countries: state.geoSelectedCodes
      .slice()
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
    set_name: (($("geo-f-set-name") && $("geo-f-set-name").value) || "").trim(),
    zone_dir: (($("geo-f-zone-dir") && $("geo-f-zone-dir").value) || "").trim(),
    apply_to_input_allows: !!($("geo-f-apply-input-allows") && $("geo-f-apply-input-allows").checked),
    break_glass: parseSourceAllowListInput(($("geo-f-break-glass") && $("geo-f-break-glass").value) || "")
      .map((c) => c.toLowerCase())
      .sort(),
    global_deny: parseSourceAllowListInput(($("geo-f-global-deny") && $("geo-f-global-deny").value) || "")
      .map((c) => c.toLowerCase())
      .sort(),
  };
}

function geoblockingServerSnapshotForCompare() {
  if (!state.lastConfig) return null;
  const g = state.lastConfig.geo || {};
  const fwd = state.lastConfig.forwarding || {};
  return {
    enabled: !!g.enabled,
    mode: String(g.mode || "allow").toLowerCase() === "block" ? "block" : "allow",
    countries: (Array.isArray(g.countries) ? g.countries : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
    set_name: String(g.set_name || "").trim(),
    zone_dir: String(g.zone_dir || "").trim(),
    apply_to_input_allows: !!g.apply_to_input_allows,
    break_glass: (Array.isArray(g.break_glass_cidrs) ? g.break_glass_cidrs : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
    global_deny: (Array.isArray(fwd.source_deny_cidrs) ? fwd.source_deny_cidrs : [])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean)
      .sort(),
  };
}

function syncGeoUnsavedIndicator() {
  const el = $("geo-unsaved-msg");
  if (!el) return;
  const srv = geoblockingServerSnapshotForCompare();
  if (!srv) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const cur = geoblockingFormSnapshotForCompare();
  const dirty = JSON.stringify(cur) !== JSON.stringify(srv);
  if (dirty) {
    el.hidden = false;
    el.textContent = "You have unsaved changes — click Save to write them to the server config.";
  } else {
    el.hidden = true;
    el.textContent = "";
  }
}

async function geoAddDetectedIP() {
  const bg = $("geo-f-break-glass");
  if (!bg) return;
  try {
    const info = await api("/v1/client-ip");
    const line = $("geo-detected-ip-line");
    if (line) {
      line.classList.remove("is-hidden");
      const ip = info.detected_client_ip || "unknown";
      line.textContent =
        "Detected: " + ip + " (" + clientIPSourceLabel(info.ip_detection_source) + ")";
    }
    if (!info.detected_client_ip) {
      setGeoMsg("Could not detect your IPv4 address.", true);
      return;
    }
    const cidr = info.detected_client_ip + "/32";
    const parts = parseSourceAllowListInput(bg.value);
    if (!parts.includes(cidr)) parts.push(cidr);
    bg.value = parts.join(", ");
    setGeoMsg("Added " + cidr + " to break-glass.");
  } catch (e) {
    setGeoMsg(String(e.message || e), true);
  }
}

/* ——— Geoblocking ——— */

function setGeoMsg(text, isErr) {
  const el = $("geo-msg");
  if (!el) return;
  const t = String(text || "");
  el.textContent = t;
  el.classList.toggle("err", !!isErr);
  el.hidden = t.length === 0;
}

function countryFlagEmoji(code) {
  const c = String(code || "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");
  if (c.length !== 2) return "";
  const cp = (ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65);
  return String.fromCodePoint(cp(c[0]), cp(c[1]));
}

async function loadGeoCountryCatalog() {
  if (state.geoCountryCatalog) return;
  const base = typeof window.EVUPROXY_STATIC === "string" ? window.EVUPROXY_STATIC : "/static";
  const r = await fetch(base + "/geo-countries.json", { credentials: "same-origin" });
  if (!r.ok) throw new Error("Could not load country list (" + r.status + ").");
  const raw = await r.json();
  state.geoCountryCatalog = raw
    .map((x) => ({
      code: String(x["alpha-2"] || "")
        .trim()
        .toLowerCase(),
      name: String(x.name || "").trim() || String(x["alpha-2"] || ""),
    }))
    .filter((x) => x.code.length === 2);
  state.geoCountryByCode = new Map(state.geoCountryCatalog.map((x) => [x.code, x]));
  state.geoCountryCatalog.sort((a, b) => a.name.localeCompare(b.name));
}

function geoCountryName(code) {
  const c = String(code || "").toLowerCase();
  const row = state.geoCountryByCode && state.geoCountryByCode.get(c);
  return row ? row.name : c.toUpperCase();
}

function getGeoListMode() {
  const allowBtn = $("geo-mode-allow");
  return allowBtn && allowBtn.classList.contains("is-active") ? "allow" : "block";
}

function setGeoListMode(mode) {
  const m = mode === "block" ? "block" : "allow";
  const blockBtn = $("geo-mode-block");
  const allowBtn = $("geo-mode-allow");
  if (blockBtn) {
    blockBtn.classList.toggle("is-active", m === "block");
    blockBtn.setAttribute("aria-pressed", m === "block" ? "true" : "false");
  }
  if (allowBtn) {
    allowBtn.classList.toggle("is-active", m === "allow");
    allowBtn.setAttribute("aria-pressed", m === "allow" ? "true" : "false");
  }
  const ex = $("geo-mode-explainer");
  if (ex) {
    ex.textContent =
      m === "allow"
        ? "Listed countries may reach public ports; others are dropped (logged)."
        : "Listed countries are blocked from public ports; others are allowed.";
  }
  const hint = $("geo-modal-hint");
  if (hint && !hint.closest(".is-hidden")) {
    hint.textContent =
      m === "allow"
        ? "Check countries to allow. Search filters the list."
        : "Check countries to block. Search filters the list.";
  }
}

function updateGeoTagsEditCount() {
  const n = $("geo-tags-edit-count");
  if (n) n.textContent = "(" + state.geoSelectedCodes.length + ")";
}

function renderGeoTags() {
  const box = $("geo-tags-chips");
  if (!box) return;
  box.innerHTML = "";
  const sorted = state.geoSelectedCodes.slice().sort((a, b) => geoCountryName(a).localeCompare(geoCountryName(b)));
  for (const code of sorted) {
    const fl = countryFlagEmoji(code);
    const tag = document.createElement("span");
    tag.className = "geo-tag";
    tag.innerHTML =
      '<span class="geo-tag-flag" aria-hidden="true">' +
      escapeHtml(fl || "·") +
      "</span>" +
      '<span class="geo-tag-name">' +
      escapeHtml(geoCountryName(code)) +
      "</span>";
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "geo-tag-remove";
    rm.setAttribute("aria-label", "Remove " + geoCountryName(code));
    rm.textContent = "×";
    rm.addEventListener("click", () => {
      state.geoSelectedCodes = state.geoSelectedCodes.filter((c) => c !== code);
      updateGeoTagsEditCount();
      renderGeoTags();
    });
    tag.appendChild(rm);
    box.appendChild(tag);
  }
  updateGeoTagsEditCount();
  syncGeoUnsavedIndicator();
}

function geoFormFromConfig(cfg) {
  const g = (cfg && cfg.geo) || {};
  const en = $("geo-f-enabled");
  const sn = $("geo-f-set-name");
  const zd = $("geo-f-zone-dir");
  const ap = $("geo-f-apply-input-allows");
  if (en) en.checked = !!g.enabled;
  if (sn) sn.value = g.set_name || "";
  if (zd) zd.value = g.zone_dir || "";
  if (ap) ap.checked = !!g.apply_to_input_allows;
  const bg = $("geo-f-break-glass");
  const gd = $("geo-f-global-deny");
  if (bg) bg.value = (g.break_glass_cidrs || []).join(", ");
  if (gd) {
    const fwd = (cfg && cfg.forwarding) || {};
    gd.value = (fwd.source_deny_cidrs || []).join(", ");
    writeRateLimitFields("geo", fwd.rate_limit || {});
  }
  const cs = $("geo-f-crowdsec-enabled");
  if (cs) cs.checked = !!((cfg && cfg.crowdsec) || {}).enabled;
  const mode = String(g.mode || "allow").toLowerCase() === "block" ? "block" : "allow";
  setGeoListMode(mode);
  state.geoSelectedCodes = Array.isArray(g.countries)
    ? g.countries.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
    : [];
  renderGeoTags();
  syncGeoUnsavedIndicator();
}

function openGeoCountryModal() {
  const modal = $("geo-country-modal");
  if (!modal) return;
  state.geoModalDraft = new Set(state.geoSelectedCodes);
  const hint = $("geo-modal-hint");
  if (hint) {
    hint.textContent =
      getGeoListMode() === "allow"
        ? "Check countries to allow. Search filters the list."
        : "Check countries to block. Search filters the list.";
  }
  const search = $("geo-modal-search");
  if (search) search.value = "";
  renderGeoModalList("");
  openModal(modal);
  const edit = $("geo-tags-edit");
  if (edit) {
    edit.setAttribute("aria-expanded", "true");
  }
  if (search) requestAnimationFrame(() => search.focus());
}

export function closeGeoCountryModal() {
  const modal = $("geo-country-modal");
  if (modal) closeModal(modal);
  const edit = $("geo-tags-edit");
  if (edit) edit.setAttribute("aria-expanded", "false");
}

function renderGeoModalList(filterRaw) {
  const list = $("geo-modal-list");
  if (!list || !state.geoCountryCatalog) return;
  const q = String(filterRaw || "")
    .trim()
    .toLowerCase();
  const rows = [];
  for (const row of state.geoCountryCatalog) {
    if (q) {
      const hay = (row.code + " " + row.name).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    const checked = state.geoModalDraft.has(row.code);
    const fl = countryFlagEmoji(row.code);
    rows.push(
      '<label class="geo-modal-row">' +
        '<input type="checkbox" data-geo-code="' +
        escapeHtml(row.code) +
        '" ' +
        (checked ? "checked " : "") +
        "/>" +
        '<span class="geo-modal-row-flag" aria-hidden="true">' +
        escapeHtml(fl || "·") +
        "</span>" +
        '<span class="geo-modal-row-name">' +
        escapeHtml(row.name) +
        "</span>" +
        "</label>"
    );
  }
  list.innerHTML = rows.length ? rows.join("") : '<p class="hint meta geo-picker-no-match">No matches.</p>';
  list.querySelectorAll('input[type="checkbox"][data-geo-code]').forEach((inp) => {
    inp.addEventListener("change", () => {
      const code = inp.getAttribute("data-geo-code");
      if (!code) return;
      if (inp.checked) state.geoModalDraft.add(code);
      else state.geoModalDraft.delete(code);
    });
  });
}

/** Config that Save would write — used by Save and by the IP check preview. */
function geoDraftFromForm() {
  if (!state.lastConfig) return null;
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.geo) cfg.geo = {};
  const g = cfg.geo;
  g.enabled = $("geo-f-enabled") && $("geo-f-enabled").checked;
  g.mode = getGeoListMode();
  g.countries = state.geoSelectedCodes.slice().map((c) => c.toLowerCase());
  g.set_name = ($("geo-f-set-name") && $("geo-f-set-name").value.trim()) || "";
  g.zone_dir = ($("geo-f-zone-dir") && $("geo-f-zone-dir").value.trim()) || "";
  g.apply_to_input_allows = !!($("geo-f-apply-input-allows") && $("geo-f-apply-input-allows").checked);
  g.break_glass_cidrs = parseSourceAllowListInput(($("geo-f-break-glass") && $("geo-f-break-glass").value) || "");
  if (!cfg.forwarding) cfg.forwarding = {};
  cfg.forwarding.source_deny_cidrs = parseSourceAllowListInput(($("geo-f-global-deny") && $("geo-f-global-deny").value) || "");
  const globalRL = readRateLimitFromForm("geo");
  if (globalRL) cfg.forwarding.rate_limit = globalRL;
  else delete cfg.forwarding.rate_limit;
  const csOn = $("geo-f-crowdsec-enabled") && $("geo-f-crowdsec-enabled").checked;
  if (csOn) cfg.crowdsec = { enabled: true };
  else delete cfg.crowdsec;
  return cfg;
}

async function saveGeoblocking() {
  const cfg = geoDraftFromForm();
  if (!cfg) return;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setGeoMsg("Saved. Review Pending changes, then Apply to host.");
    setApiStatus(true);
    refreshPendingBadge();
    syncGeoUnsavedIndicator();
  } catch (e) {
    setGeoMsg(String(e.message || e), true);
  }
}

function clearGeoIPCheckResult() {
  const panel = $("geo-ip-check-result");
  if (!panel) return;
  panel.classList.add("is-hidden");
  panel.classList.remove("evu-alert--success", "evu-alert--danger", "evu-alert--warning", "evu-alert--info");
}

function renderGeoIPCheckResult(res) {
  const panel = $("geo-ip-check-result");
  const summary = $("geo-ip-check-summary");
  const detail = $("geo-ip-check-detail");
  if (!panel || !summary || !detail) return;
  panel.classList.remove("is-hidden", "evu-alert--success", "evu-alert--danger", "evu-alert--warning", "evu-alert--info");
  const tone =
    res.verdict === "allowed"
      ? "evu-alert--success"
      : res.verdict === "blocked"
        ? "evu-alert--danger"
        : res.verdict === "geo_off"
          ? "evu-alert--info"
          : "evu-alert--warning"; // invalid | uncertain
  panel.classList.add(tone);
  summary.textContent = res.summary || String(res.verdict || "");
  const bits = [];
  if (res.country_iso) bits.push("Country: " + String(res.country_iso).toUpperCase());
  if (Array.isArray(res.matched_countries) && res.matched_countries.length) {
    bits.push(
      "Listed match: " +
        res.matched_countries.map((c) => geoCountryName(c) + " (" + String(c).toUpperCase() + ")").join(", ")
    );
  }
  if (res.break_glass) bits.push("Break-glass");
  if (res.global_deny) bits.push("Global denylist");
  if (res.checked_from_draft) bits.push("Using form rules (unsaved edits included)");
  if (res.note) bits.push(res.note);
  detail.textContent = bits.join(" · ");
  detail.hidden = bits.length === 0;
}

async function runGeoIPCheck() {
  const input = $("geo-ip-check-input");
  const runBtn = $("geo-ip-check-run");
  if (!input) return;
  const ip = input.value.trim();
  if (!ip) {
    input.focus();
    clearGeoIPCheckResult();
    const panel = $("geo-ip-check-result");
    const summary = $("geo-ip-check-summary");
    const detail = $("geo-ip-check-detail");
    if (panel && summary) {
      panel.classList.remove("is-hidden");
      panel.classList.add("evu-alert--warning");
      summary.textContent = "Enter a valid IPv4 address.";
      if (detail) {
        detail.textContent = "";
        detail.hidden = true;
      }
    }
    return;
  }
  const cfg = geoDraftFromForm();
  if (!cfg) {
    setGeoMsg("Load the page first, then try again.", true);
    return;
  }
  if (runBtn) runBtn.disabled = true;
  try {
    const res = await api("/v1/geo/check-ip", {
      method: "POST",
      body: JSON.stringify({ ip, config: cfg }),
    });
    renderGeoIPCheckResult(res);
    setApiStatus(true);
  } catch (e) {
    clearGeoIPCheckResult();
    setGeoMsg(String(e.message || e), true);
  } finally {
    if (runBtn) runBtn.disabled = false;
  }
}

async function geoIPCheckUseMine() {
  const input = $("geo-ip-check-input");
  if (!input) return;
  try {
    const info = await api("/v1/client-ip");
    if (!info.detected_client_ip) {
      setGeoMsg("Could not detect your IPv4 address.", true);
      return;
    }
    input.value = info.detected_client_ip;
    await runGeoIPCheck();
  } catch (e) {
    setGeoMsg(String(e.message || e), true);
  }
}

/**
 * @param {{ resetTab?: boolean }} [opts] `resetTab` on route entry only — the
 *   Refresh button is in the shared footer, so resetting there would throw the
 *   operator off the tab whose data they just reloaded.
 */
export async function refreshGeoblockingPage(opts) {
  setGeoMsg("");
  clearGeoIPCheckResult();
  // The catalog is a static asset used only to show country names. Loading it
  // first inside the same try meant a missing file failed the whole page and
  // reported the API as down; names then fall back to ISO codes instead.
  try {
    await loadGeoCountryCatalog();
  } catch (e) {
    /* names degrade to codes */
  }
  try {
    state.lastConfig = await api("/v1/config");
    setApiStatus(true);
    geoFormFromConfig(state.lastConfig);
  } catch (e) {
    setApiStatus(false, String(e.message || e));
    setGeoMsg(String(e.message || e), true);
  }
  if (opts && opts.resetTab) setGeoEditorTab("default");
  syncAdvancedTabsGating();
  void refreshGeoZonesTable();
}

async function geoUpdateLists() {
  setGeoMsg("…");
  try {
    await api("/v1/update-geo", { method: "POST" });
    setGeoMsg("Geo lists updated on host.");
    setApiStatus(true);
    // The Zone files tab is where an operator confirms the update landed.
    void refreshGeoZonesTable();
  } catch (e) {
    setGeoMsg(String(e.message || e), true);
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initGeoblockingPage() {
  const geoAddIP = $("geo-add-detected-ip");
  if (geoAddIP) geoAddIP.addEventListener("click", () => void geoAddDetectedIP());

  for (const name of ["default", "advanced", "zones"]) {
    const btn = $(`geo-tab-${name}-btn`);
    if (btn) btn.addEventListener("click", () => setGeoEditorTab(name));
  }
  $("geo-save").addEventListener("click", saveGeoblocking);
  $("geo-refresh").addEventListener("click", () => void refreshGeoblockingPage());
  $("geo-update-lists").addEventListener("click", geoUpdateLists);
  const geoEn = $("geo-f-enabled");
  if (geoEn) geoEn.addEventListener("change", syncGeoUnsavedIndicator);
  const geoSn = $("geo-f-set-name");
  if (geoSn) geoSn.addEventListener("input", syncGeoUnsavedIndicator);
  const geoZd = $("geo-f-zone-dir");
  if (geoZd) geoZd.addEventListener("input", syncGeoUnsavedIndicator);
  const geoApplyInputAllows = $("geo-f-apply-input-allows");
  if (geoApplyInputAllows) geoApplyInputAllows.addEventListener("change", syncGeoUnsavedIndicator);
  const geoBreakGlass = $("geo-f-break-glass");
  if (geoBreakGlass) geoBreakGlass.addEventListener("input", syncGeoUnsavedIndicator);
  const geoGlobalDeny = $("geo-f-global-deny");
  if (geoGlobalDeny) geoGlobalDeny.addEventListener("input", syncGeoUnsavedIndicator);
  const geoModeBlock = $("geo-mode-block");
  const geoModeAllow = $("geo-mode-allow");
  if (geoModeBlock) {
    geoModeBlock.addEventListener("click", () => {
      setGeoListMode("block");
      syncGeoUnsavedIndicator();
    });
  }
  if (geoModeAllow) {
    geoModeAllow.addEventListener("click", () => {
      setGeoListMode("allow");
      syncGeoUnsavedIndicator();
    });
  }
  const geoTagsEdit = $("geo-tags-edit");
  if (geoTagsEdit) geoTagsEdit.addEventListener("click", openGeoCountryModal);
  const geoModalBackdrop = $("geo-modal-backdrop");
  if (geoModalBackdrop) geoModalBackdrop.addEventListener("click", closeGeoCountryModal);
  const geoModalCancel = $("geo-modal-cancel");
  if (geoModalCancel) geoModalCancel.addEventListener("click", closeGeoCountryModal);
  const geoModalSave = $("geo-modal-save");
  if (geoModalSave) {
    geoModalSave.addEventListener("click", () => {
      state.geoSelectedCodes = Array.from(state.geoModalDraft);
      renderGeoTags();
      closeGeoCountryModal();
    });
  }
  const geoModalSearch = $("geo-modal-search");
  if (geoModalSearch) {
    geoModalSearch.addEventListener("input", () => renderGeoModalList(geoModalSearch.value));
  }
  const geoIPCheckRun = $("geo-ip-check-run");
  if (geoIPCheckRun) geoIPCheckRun.addEventListener("click", () => void runGeoIPCheck());
  const geoIPCheckMine = $("geo-ip-check-mine");
  if (geoIPCheckMine) geoIPCheckMine.addEventListener("click", () => void geoIPCheckUseMine());
  const geoIPCheckInput = $("geo-ip-check-input");
  if (geoIPCheckInput) {
    geoIPCheckInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void runGeoIPCheck();
      }
    });
  }
}
