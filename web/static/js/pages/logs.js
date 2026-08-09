import { state } from "../core/state.js";
import { $, escapeHtml, trunc, setApiStatus } from "../core/dom.js";
import { api } from "../core/api.js";
import { ipv4CoveredByCIDRList, ipv4ToInt } from "../core/net.js";
import { openConfirmModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

/* ——— Logs ——— */
const LOG_PREFIX_GEO = "evuproxy-geo-block";
const LOG_PREFIX_RATELIMIT = "evuproxy-ratelimit";
const LOG_PREFIX_FWD = "evuproxy-forward-drop";
const LOG_PREFIX_CROWDSEC = "evuproxy-crowdsec";

/** Shield+ icon for "add this source to break-glass". */
const LOGS_BREAKGLASS_ICON =
  '<svg class="logs-breakglass-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M12 9v6M9 12h6"/></svg>';

/** journalctl: "TIME HOST kernel: …"; dmesg / fallback: prefix may appear without the " kernel: " marker. */
function parseFirewallLogLine(raw) {
  const line = String(raw || "");
  let tsDisplay = null;
  let body = line;
  const kMarker = " kernel: ";
  const kIdx = line.indexOf(kMarker);
  if (kIdx >= 0) {
    const journalMeta = line.slice(0, kIdx).trim();
    const metaParts = journalMeta.split(/\s+/);
    if (metaParts.length >= 1) tsDisplay = metaParts[0];
    body = line.slice(kIdx + kMarker.length);
  }
  let kind = "unknown";
  let rest = body.trim();
  const geoNeedle = LOG_PREFIX_GEO + ":";
  const rlNeedle = LOG_PREFIX_RATELIMIT + ":";
  const fwdNeedle = LOG_PREFIX_FWD + ":";
  const csNeedle = LOG_PREFIX_CROWDSEC + ":";
  const gi = body.indexOf(geoNeedle);
  const ri = body.indexOf(rlNeedle);
  const fi = body.indexOf(fwdNeedle);
  const ci = body.indexOf(csNeedle);
  let best = -1;
  let bestKind = "";
  let bestNeedle = "";
  if (gi >= 0 && (best < 0 || gi < best)) {
    best = gi;
    bestKind = "geo";
    bestNeedle = geoNeedle;
  }
  if (ri >= 0 && (best < 0 || ri < best)) {
    best = ri;
    bestKind = "ratelimit";
    bestNeedle = rlNeedle;
  }
  if (fi >= 0 && (best < 0 || fi < best)) {
    best = fi;
    bestKind = "forward";
    bestNeedle = fwdNeedle;
  }
  if (ci >= 0 && (best < 0 || ci < best)) {
    best = ci;
    bestKind = "crowdsec";
    bestNeedle = csNeedle;
  }
  if (best >= 0) {
    kind = bestKind;
    rest = body.slice(best + bestNeedle.length).trim();
  }
  const kv = {};
  const flags = [];
  const tokens = rest.split(/\s+/).filter(Boolean);
  const kvRe = /^([A-Z][A-Z0-9]*)=(.*)$/;
  for (const t of tokens) {
    const m = t.match(kvRe);
    if (m) {
      const key = m[1];
      const val = m[2];
      if (!kv[key]) kv[key] = [];
      kv[key].push(val);
    } else {
      flags.push(t);
    }
  }
  function first(key) {
    const a = kv[key];
    return a && a[0] !== undefined ? a[0] : "";
  }
  const lenVals = kv.LEN || [];
  let lenCol = "—";
  if (lenVals.length === 1) lenCol = lenVals[0];
  else if (lenVals.length > 1) lenCol = lenVals.join(" / ");
  const kvFlat = Object.keys(kv)
    .sort()
    .flatMap((key) => kv[key].map((v) => key + "=" + v))
    .join(" ");
  const searchBlob = (
    line +
    " " +
    kvFlat +
    " " +
    flags.join(" ")
  ).toLowerCase();
  let parsedTimeMs = NaN;
  if (tsDisplay) {
    const n = Date.parse(tsDisplay);
    if (!Number.isNaN(n)) parsedTimeMs = n;
  }
  return {
    raw: line,
    tsDisplay,
    parsedTimeMs,
    kind,
    kv,
    flags,
    searchBlob,
    src: first("SRC"),
    dst: first("DST"),
    proto: first("PROTO"),
    spt: first("SPT"),
    dpt: first("DPT"),
    inn: first("IN"),
    out: first("OUT"),
    lenCol,
    flagsStr: flags.length ? flags.join(" ") : "—",
  };
}

function logsDatetimeLocalInputMs(inp) {
  if (!inp || !inp.value) return null;
  const t = new Date(inp.value).getTime();
  return Number.isNaN(t) ? null : t;
}

function filterFirewallLogEntries(entries, typeFilter, needle, rangeFromMs, rangeToMs) {
  const fromActive = rangeFromMs != null && Number.isFinite(rangeFromMs);
  const toActive = rangeToMs != null && Number.isFinite(rangeToMs);
  return entries.filter((e) => {
    if (typeFilter === "geo" && e.kind !== "geo") return false;
    if (typeFilter === "ratelimit" && e.kind !== "ratelimit") return false;
    if (typeFilter === "forward" && e.kind !== "forward") return false;
    if (typeFilter === "crowdsec" && e.kind !== "crowdsec") return false;
    if (needle && !e.searchBlob.includes(needle)) return false;
    if (fromActive || toActive) {
      if (!Number.isFinite(e.parsedTimeMs)) return false;
      if (fromActive && e.parsedTimeMs < rangeFromMs) return false;
      if (toActive && e.parsedTimeMs > rangeToMs) return false;
    }
    return true;
  });
}

function firewallLogKindLabel(kind) {
  if (kind === "geo") return "Geoblock";
  if (kind === "ratelimit") return "Rate limit";
  if (kind === "forward") return "Forward drop";
  if (kind === "crowdsec") return "CrowdSec";
  return "—";
}

/** ISO 3166-1 alpha-2 → regional indicator flag emoji (empty if invalid). */
function countryCodeToFlagEmoji(cc) {
  if (cc == null || cc === "") return "";
  const s = String(cc).trim();
  if (s.length !== 2) return "";
  const base = 0x1f1e6;
  const u = s.toUpperCase();
  const c1 = u.codePointAt(0);
  const c2 = u.codePointAt(1);
  if (c1 < 65 || c1 > 90 || c2 < 65 || c2 > 90) return "";
  return String.fromCodePoint(base + (c1 - 65), base + (c2 - 65));
}

function breakGlassCIDRsFromConfig() {
  const g = (state.lastConfig && state.lastConfig.geo) || {};
  return Array.isArray(g.break_glass_cidrs) ? g.break_glass_cidrs : [];
}

/**
 * SRC cell for a geoblock drop: offer break-glass when this IPv4 is not already
 * covered by geo.break_glass_cidrs (exact /32 or containing range).
 */
function logsIpCell(ip, cc, opts) {
  const raw = String(ip || "").trim();
  const ipPart = raw === "" ? "—" : escapeHtml(raw);
  const code = cc && String(cc).trim();
  const flag = code ? countryCodeToFlagEmoji(code) : "";
  const title = code ? escapeHtml(code.toUpperCase()) : "";
  const flagPart = flag
    ? '<span class="logs-ip-flag" aria-hidden="true" title="' + title + '">' + flag + "</span> "
    : "";
  let action = "";
  if (opts && opts.offerBreakGlass && raw && ipv4ToInt(raw) !== null) {
    if (!ipv4CoveredByCIDRList(raw, breakGlassCIDRsFromConfig())) {
      const label = "Add " + raw + " to break-glass list";
      action =
        ' <button type="button" class="evu-btn evu-btn--ghost evu-btn--icon evu-btn--sm logs-breakglass-btn" data-logs-breakglass="' +
        escapeHtml(raw) +
        '" aria-label="' +
        escapeHtml(label) +
        '" title="' +
        escapeHtml(label) +
        '">' +
        LOGS_BREAKGLASS_ICON +
        "</button>";
    }
  }
  const cls = code || action ? "mono logs-col-ip" : "mono";
  return '<td class="' + cls + '">' + flagPart + ipPart + action + "</td>";
}

function setLogsViewMode(mode) {
  state.logsViewMode = mode === "raw" ? "raw" : "table";
  const bTable = $("logs-view-table");
  const bRaw = $("logs-view-raw");
  if (bTable) {
    bTable.classList.toggle("is-active", state.logsViewMode === "table");
    bTable.setAttribute("aria-pressed", state.logsViewMode === "table" ? "true" : "false");
  }
  if (bRaw) {
    bRaw.classList.toggle("is-active", state.logsViewMode === "raw");
    bRaw.setAttribute("aria-pressed", state.logsViewMode === "raw" ? "true" : "false");
  }
  renderLogsView();
}

function clearLogsFilters() {
  clearTimeout(state.logsSearchDebounceTimer);
  state.logsSearchDebounceTimer = null;
  const typeSel = $("logs-filter-type");
  const searchInp = $("logs-search");
  const dateFrom = $("logs-date-from");
  const dateTo = $("logs-date-to");
  if (typeSel) typeSel.value = "";
  if (searchInp) searchInp.value = "";
  if (dateFrom) dateFrom.value = "";
  if (dateTo) dateTo.value = "";
  renderLogsView();
}

let logsCountAnnounceTimer = null;

/**
 * Mirrors the visible result count into a live region once filtering settles.
 *
 * The visible count follows every keystroke so sighted users get immediate
 * feedback; announcing at that rate would talk over the person typing, so the
 * spoken copy waits for a pause.
 */
function announceLogsCount(text) {
  const status = $("logs-count-status");
  if (!status) return;
  clearTimeout(logsCountAnnounceTimer);
  logsCountAnnounceTimer = setTimeout(() => {
    if (status.textContent !== text) status.textContent = text;
  }, 900);
}

function renderLogsView() {
  const typeSel = $("logs-filter-type");
  const searchInp = $("logs-search");
  const dateFromInp = $("logs-date-from");
  const dateToInp = $("logs-date-to");
  const wrap = $("logs-table-wrap");
  const pre = $("logs-pre");
  const countEl = $("logs-count");
  const typeF = typeSel ? String(typeSel.value || "") : "";
  const needle = (searchInp && searchInp.value.trim().toLowerCase()) || "";
  const rangeFromMs = logsDatetimeLocalInputMs(dateFromInp);
  const rangeToMs = logsDatetimeLocalInputMs(dateToInp);
  const filtered = filterFirewallLogEntries(
    state.lastFirewallLogEntries,
    typeF,
    needle,
    rangeFromMs,
    rangeToMs
  );
  const total = state.lastFirewallLogEntries.length;
  if (countEl) {
    if (!total) countEl.textContent = "";
    else {
      countEl.textContent =
        "Showing " +
        filtered.length +
        " of " +
        total +
        " entr" +
        (total === 1 ? "y" : "ies");
    }
    announceLogsCount(countEl.textContent);
  }
  const rawMode = state.logsViewMode === "raw";
  if (wrap) wrap.hidden = rawMode;
  if (pre) pre.hidden = !rawMode;
  if (rawMode) {
    if (pre) {
      if (!total) pre.textContent = "No log lines returned from the host.";
      else
        pre.textContent = filtered.length
          ? filtered.map((e) => e.raw).join("\n")
          : "No lines match the current filters.";
    }
    return;
  }
  if (!wrap) return;
  if (!total) {
    wrap.innerHTML =
      "<div class=\"evu-empty\"><p class=\"evu-empty__title\">No log lines yet</p><p>Nothing matching EvuProxy drop prefixes since boot/rotation, or the API cannot read the kernel journal (non-root <code class=\"inline\">evuproxy-api</code> needs the <code class=\"inline\">systemd-journal</code> group). Check the Source line above.</p></div>";
    return;
  }
  if (!filtered.length) {
    wrap.innerHTML =
      "<div class=\"evu-empty\"><p class=\"evu-empty__title\">No lines match the current filters</p><p>Widen the time range or clear the filters to see more.</p><button type=\"button\" class=\"evu-btn evu-btn--outline\" id=\"logs-empty-clear\">Clear filters</button></div>";
    const clearBtn = wrap.querySelector("#logs-empty-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const toolbarClear = $("logs-filter-clear");
        if (!toolbarClear) return;
        toolbarClear.click();
        // Clearing re-renders this table, destroying the button that was just
        // activated; without this, focus falls back to <body>.
        toolbarClear.focus();
      });
    }
    return;
  }
  const rows = filtered
    .map((e) => {
      const tlabel = firewallLogKindLabel(e.kind);
      const ts = e.tsDisplay || "—";
      const cell = (v) => (v === "" ? "—" : escapeHtml(v));
      const flagsDisp = e.flagsStr === "—" ? "—" : escapeHtml(trunc(e.flagsStr, 80));
      const flagsTitle =
        e.flagsStr === "—" ? "" : escapeHtml(trunc(e.flagsStr, 400));
      return (
        "<tr>" +
        '<td class="mono">' +
        escapeHtml(ts) +
        "</td>" +
        '<td class="logs-col-type">' +
        escapeHtml(tlabel) +
        "</td>" +
        logsIpCell(e.src, e.srcCC, { offerBreakGlass: e.kind === "geo" }) +
        logsIpCell(e.dst, e.dstCC) +
        "<td>" +
        cell(e.proto) +
        "</td>" +
        '<td class="mono">' +
        cell(e.spt) +
        "</td>" +
        '<td class="mono">' +
        cell(e.dpt) +
        "</td>" +
        "<td>" +
        cell(e.inn) +
        "</td>" +
        "<td>" +
        cell(e.out) +
        "</td>" +
        '<td class="mono">' +
        cell(e.lenCol) +
        "</td>" +
        '<td class="mono logs-col-flags" title="' +
        flagsTitle +
        '">' +
        flagsDisp +
        "</td>" +
        "</tr>"
      );
    })
    .join("");
  wrap.innerHTML =
    '<table class="data logs-data" aria-describedby="logs-count"><thead><tr>' +
    "<th scope=\"col\">Time</th><th scope=\"col\">Type</th><th scope=\"col\">SRC</th><th scope=\"col\">DST</th><th scope=\"col\">Proto</th><th scope=\"col\">SPT</th><th scope=\"col\">DPT</th><th scope=\"col\">IN</th><th scope=\"col\">OUT</th><th scope=\"col\">LEN</th><th scope=\"col\">Flags</th>" +
    "</tr></thead><tbody>" +
    rows +
    "</tbody></table>";
}

function setLogsMsg(text, isErr) {
  const el = $("logs-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

export async function refreshLogsPage() {
  const seq = ++state.logsRefreshSeq;
  const pre = $("logs-pre");
  const wrap = $("logs-table-wrap");
  const src = $("logs-source");
  const countEl = $("logs-count");
  setLogsMsg("");
  if (pre) pre.textContent = "";
  if (wrap) wrap.innerHTML = "";
  if (countEl) countEl.textContent = "";
  if (src) src.textContent = "";
  state.lastFirewallLogEntries = [];
  try {
    // Logs must not depend on /config: a config read failure used to blank the
    // whole page. Break-glass coverage is best-effort from a parallel config fetch.
    const logsP = api("/v1/logs?limit=1000");
    const cfgP = api("/v1/config").catch(() => null);
    const j = await logsP;
    if (seq !== state.logsRefreshSeq) return;
    const cfg = await cfgP;
    if (seq !== state.logsRefreshSeq) return;
    if (cfg) state.lastConfig = cfg;
    setApiStatus(true);
    if (src) {
      src.textContent = j.source ? "Source: " + j.source : "";
    }
    const lines = j.lines || [];
    const lineGeo = j.line_geo || [];
    state.lastFirewallLogEntries = lines.map((raw, i) => {
      const e = parseFirewallLogLine(raw);
      const g = lineGeo[i];
      if (g && typeof g === "object") {
        if (g.src_cc) {
          e.srcCC = g.src_cc;
          e.searchBlob += " " + String(g.src_cc).toLowerCase();
        }
        if (g.dst_cc) {
          e.dstCC = g.dst_cc;
          e.searchBlob += " " + String(g.dst_cc).toLowerCase();
        }
      }
      return e;
    });
    renderLogsView();
  } catch (e) {
    if (seq !== state.logsRefreshSeq) return;
    setApiStatus(false, String(e.message || e));
    setLogsMsg(String(e.message || e), true);
    state.lastFirewallLogEntries = [];
    if (wrap) {
      wrap.innerHTML = "";
      wrap.hidden = state.logsViewMode === "raw";
    }
    if (pre) {
      pre.textContent = "";
      pre.hidden = state.logsViewMode !== "raw";
    }
    if (countEl) countEl.textContent = "";
  }
}

/** One break-glass write at a time so overlapping GET→PUT cannot drop a sibling /32. */
let logsBreakGlassBusy = false;

function confirmAddBreakGlass(ip) {
  if (logsBreakGlassBusy) return;
  const cidr = ip + "/32";
  openConfirmModal({
    title: "Add to break-glass?",
    message:
      "Add " +
      cidr +
      " to the geoblocking break-glass list? That address will bypass country rules after you Apply from Pending changes.",
    confirmLabel: "Add to break-glass",
    onConfirm: async () => {
      if (logsBreakGlassBusy) return;
      logsBreakGlassBusy = true;
      // Drop any in-flight Logs refresh so its older config cannot overwrite this write.
      state.logsRefreshSeq++;
      setLogsMsg("…");
      try {
        const cfg = await api("/v1/config");
        if (!cfg.geo) cfg.geo = {};
        const list = Array.isArray(cfg.geo.break_glass_cidrs) ? cfg.geo.break_glass_cidrs.slice() : [];
        if (ipv4CoveredByCIDRList(ip, list)) {
          state.logsRefreshSeq++;
          state.lastConfig = cfg;
          setLogsMsg(ip + " is already covered by the break-glass list.");
          renderLogsView();
          return;
        }
        list.push(cidr);
        cfg.geo.break_glass_cidrs = list;
        await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
        state.logsRefreshSeq++;
        state.lastConfig = cfg;
        setLogsMsg("Added " + cidr + " to break-glass. Review Pending changes, then Apply.");
        setApiStatus(true);
        await refreshPendingBadge();
        renderLogsView();
      } catch (e) {
        setLogsMsg(String(e.message || e), true);
      } finally {
        logsBreakGlassBusy = false;
      }
    },
  });
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initLogsPage() {
  $("logs-refresh").addEventListener("click", refreshLogsPage);
  const tableWrap = $("logs-table-wrap");
  if (tableWrap) {
    tableWrap.addEventListener("click", (ev) => {
      const btn = ev.target.closest("[data-logs-breakglass]");
      if (!btn || !tableWrap.contains(btn)) return;
      const ip = btn.getAttribute("data-logs-breakglass");
      if (ip) confirmAddBreakGlass(ip);
    });
  }
  const logsFilterType = $("logs-filter-type");
  if (logsFilterType) logsFilterType.addEventListener("change", () => renderLogsView());
  const logsDateFrom = $("logs-date-from");
  const logsDateTo = $("logs-date-to");
  function bindLogsDatetimeFilter(inp) {
    if (!inp) return;
    inp.addEventListener("change", () => renderLogsView());
    inp.addEventListener("input", () => renderLogsView());
  }
  bindLogsDatetimeFilter(logsDateFrom);
  bindLogsDatetimeFilter(logsDateTo);
  const logsSearch = $("logs-search");
  if (logsSearch) {
    logsSearch.addEventListener("input", () => {
      clearTimeout(state.logsSearchDebounceTimer);
      state.logsSearchDebounceTimer = setTimeout(() => renderLogsView(), 220);
    });
  }
  const logsFilterClear = $("logs-filter-clear");
  if (logsFilterClear) logsFilterClear.addEventListener("click", () => clearLogsFilters());
  const logsViewTable = $("logs-view-table");
  const logsViewRaw = $("logs-view-raw");
  if (logsViewTable) logsViewTable.addEventListener("click", () => setLogsViewMode("table"));
  if (logsViewRaw) logsViewRaw.addEventListener("click", () => setLogsViewMode("raw"));
}
