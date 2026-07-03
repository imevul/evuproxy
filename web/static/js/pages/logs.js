import { state } from "../core/state.js";
import { $, escapeHtml, trunc, setApiStatus } from "../core/dom.js";
import { api } from "../core/api.js";

/* ——— Logs ——— */
const LOG_PREFIX_GEO = "evuproxy-geo-block";
const LOG_PREFIX_RATELIMIT = "evuproxy-ratelimit";
const LOG_PREFIX_FWD = "evuproxy-forward-drop";
const LOG_PREFIX_CROWDSEC = "evuproxy-crowdsec";

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

function logsIpCell(ip, cc) {
  const ipPart = ip === "" ? "—" : escapeHtml(ip);
  const code = cc && String(cc).trim();
  if (!code) {
    return '<td class="mono">' + ipPart + "</td>";
  }
  const flag = countryCodeToFlagEmoji(code);
  const title = escapeHtml(code.toUpperCase());
  const flagPart = flag
    ? '<span class="logs-ip-flag" title="' + title + '">' + flag + "</span> "
    : "";
  return '<td class="mono logs-col-ip">' + flagPart + ipPart + "</td>";
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
    wrap.innerHTML = "<p class=\"hint\">No log lines returned from the host.</p>";
    return;
  }
  if (!filtered.length) {
    wrap.innerHTML = "<p class=\"hint\">No lines match the current filters.</p>";
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
        logsIpCell(e.src, e.srcCC) +
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
    "<th>Time</th><th>Type</th><th>SRC</th><th>DST</th><th>Proto</th><th>SPT</th><th>DPT</th><th>IN</th><th>OUT</th><th>LEN</th><th>Flags</th>" +
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
    const j = await api("/v1/logs?limit=1000");
    if (seq !== state.logsRefreshSeq) return;
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

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initLogsPage() {
  $("logs-refresh").addEventListener("click", refreshLogsPage);
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
