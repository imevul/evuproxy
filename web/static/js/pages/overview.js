import { state } from "../core/state.js";
import { $, escapeHtml, setApiNotConnected, setApiStatus, downloadTextFile, eventsToCsv } from "../core/dom.js";
import { applyErrorText, eventDetail, eventLabel, geoSourceLabel, timeHtml } from "../core/format.js";
import { beginLoading } from "../core/loading.js";
import { api, token, applyNavRestriction } from "../core/api.js";
import { showToast } from "../core/toast.js";
import { saveConfigEdit } from "../core/config_save.js";
import { showUndoToast } from "../core/undo.js";
import { fetchUIPrefsFromServer } from "../core/prefs.js";
import {
  wgPeerPubKeyMap,
  PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC,
  formatDashboardMinAvgMax,
} from "../core/peers_data.js";
import { tunnelToHost } from "../core/net.js";
import { refreshPendingBadge } from "./pending.js";
import { openConfirmModal } from "../core/modal.js";
import {
  fetchValidateResult,
  lockoutRiskLines,
  lockoutRisks,
  lockoutSignature,
} from "../core/lockout.js";

/** 1 min aligns with collector buckets; avoids doubling load with full overview refetch. */
const OVERVIEW_LATENCY_POLL_MS = 60 * 1000;

const GEO_STALE_MS = 30 * 24 * 60 * 60 * 1000;
/** Overview "Needs attention" when rolling 10m ICMP avg is at or above this (ms). */
const OVERVIEW_LATENCY_LAST10M_WARN_MS = 500;
/** ICMP spark SVG geometry viewBox width/height (px). */
const PING_SPARK_VB_WIDTH = 640;
const PING_SPARK_VB_HEIGHT = 208;

function themeColor(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
}

export function stopOverviewLatencyPolling() {
  if (state.overviewLatencyPollTimer) {
    clearInterval(state.overviewLatencyPollTimer);
    state.overviewLatencyPollTimer = null;
  }
}

export function restartOverviewLatencyPolling() {
  stopOverviewLatencyPolling();
  state.overviewLatencyPollTimer = setInterval(() => {
    void refreshOverviewLatencyCardOnly();
  }, OVERVIEW_LATENCY_POLL_MS);
}

/** Replaces `#overview-latency-card` with fresh `/v1/metrics/peers` data (no full overview reload). */
async function refreshOverviewLatencyCardOnly() {
  const seq = ++state.overviewLatencyPollSeq;
  if (!token().trim()) return;
  const ov = $("page-overview");
  if (!ov || ov.hidden) return;
  const card = $("overview-latency-card");
  if (!card) return;
  try {
    const met = await api("/v1/metrics/peers");
    if (seq !== state.overviewLatencyPollSeq) return;
    const cur = $("overview-latency-card");
    const parent = cur && cur.parentNode;
    if (!parent || seq !== state.overviewLatencyPollSeq || cur !== card) return;
    parent.replaceChild(overviewLatencyOverviewCard(met), cur);
  } catch (_) {
    /* retain last rendered chart while API is flaky */
  }
}

export function stopOverviewEventsPolling() {
  if (state.overviewEventsTimer) {
    clearInterval(state.overviewEventsTimer);
    state.overviewEventsTimer = null;
  }
}

export function restartOverviewEventsPolling() {
  stopOverviewEventsPolling();
  void refreshOverviewEventsList();
  state.overviewEventsTimer = setInterval(refreshOverviewEventsList, 30000);
}

export async function refreshOverviewEventsList() {
  const ul = $("overview-events-list");
  const empty = $("overview-events-empty");
  const card = $("overview-events-card");
  if (!ul || !empty) return;
  if (!token().trim()) {
    ul.innerHTML = "";
    empty.classList.remove("is-hidden");
    if (card) card.hidden = true;
    return;
  }
  if (card) card.hidden = false;
  try {
    const data = await api("/v1/events?limit=25");
    const evs = data.events || [];
    if (!evs.length) {
      ul.innerHTML = "";
      empty.classList.remove("is-hidden");
      state.lastEventsForExport = [];
      return;
    }
    empty.classList.add("is-hidden");
    state.lastEventsForExport = evs;
    ul.innerHTML = evs
      .map(
        (e) =>
          "<li><strong>" +
          escapeHtml(eventLabel(e.event)) +
          "</strong> · <span class=\"overview-ev-ts\">" +
          timeHtml(e.ts) +
          "</span>" +
          (eventDetail(e) ? " — " + escapeHtml(eventDetail(e)) : "") +
          (e.error_code ? " <code class=\"inline\">" + escapeHtml(e.error_code) + "</code>" : "") +
          "</li>"
      )
      .join("");
  } catch {
    /* non-fatal */
  }
}

/* ——— Overview ——— */
function overviewApiIssueCard(opts) {
  const wrap = document.createElement("div");
  wrap.className = "evu-card card overview-api-issue-card";
  const p = document.createElement("p");
  p.textContent = opts.message;
  wrap.appendChild(p);
  const linkP = document.createElement("p");
  linkP.className = "hint";
  linkP.style.marginTop = "0.75rem";
  const a = document.createElement("a");
  a.href = "#/token";
  a.textContent = "Open API token";
  linkP.appendChild(a);
  linkP.appendChild(document.createTextNode(" to set the token and optional API base URL."));
  wrap.appendChild(linkP);
  if (opts.detail) {
    const d = document.createElement("p");
    d.className = "hint meta";
    d.style.marginTop = "0.5rem";
    d.textContent = opts.detail;
    wrap.appendChild(d);
  }
  return wrap;
}

function pingSeriesFromDashboard(met) {
  const hist = met && met.dashboard && met.dashboard.ping_history;
  if (!Array.isArray(hist)) return [];
  const out = [];
  for (const p of hist) {
    const v = Number(p && p.avg_ms);
    if (Number.isFinite(v)) out.push(v);
  }
  return out;
}

function axisTimeLabelFromIso(iso) {
  if (!iso || typeof iso !== "string") return "";
  const m = iso.match(/T(\d{2}):(\d{2})/);
  if (m) return m[1] + ":" + m[2] + "Z";
  return iso.length > 13 ? iso.slice(11, 16) + "Z" : iso;
}

/** Average of first/last UTC instants formatted like `axisTimeLabelFromIso`. */
function axisMidLabelFromUtcIsoPair(fromIso, toIso) {
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return "";
  return axisTimeLabelFromIso(new Date(Math.round((a + b) / 2)).toISOString());
}

function pingPointsFromPingHistory(met) {
  const hist = met && met.dashboard && met.dashboard.ping_history;
  if (!Array.isArray(hist) || hist.length < 2) return null;
  const ys = [];
  const ts = [];
  for (const p of hist) {
    const v = Number(p && p.avg_ms);
    const t = p && p.ts_utc != null ? String(p.ts_utc).trim() : "";
    if (!Number.isFinite(v) || !t) continue;
    ys.push(v);
    ts.push(t);
  }
  if (ys.length < 2) return null;
  const xMid = axisMidLabelFromUtcIsoPair(ts[0], ts[ts.length - 1]);
  return {
    ys: ys,
    xLeft: axisTimeLabelFromIso(ts[0]),
    xRight: axisTimeLabelFromIso(ts[ts.length - 1]),
    xMid: xMid,
  };
}

/* Milliseconds — aligns with docker/mock-api `ping_history` so the Overview spark renders before SQLite buckets fill. */
const OVERVIEW_DEV_PING_SPARK_SERIES = [19, 22, 25, 31, 38, 35, 29, 24, 21, 23, 20, 18, 22, 26, 21];

function pingSeriesForSpark(met) {
  const fromApi = pingSeriesFromDashboard(met);
  if (fromApi.length >= 2) return fromApi;
  try {
    if (window.__EVUPROXY_DEV_UI__ === true && OVERVIEW_DEV_PING_SPARK_SERIES.length >= 2) {
      return OVERVIEW_DEV_PING_SPARK_SERIES;
    }
  } catch (e) {
    /* ignore */
  }
  return fromApi;
}

function pingSparkChartModel(met) {
  const fromHist = pingPointsFromPingHistory(met);
  if (fromHist) return fromHist;
  const ys = pingSeriesForSpark(met);
  if (ys.length < 2) return { ys: [], xLeft: "", xRight: "", xMid: "" };
  return { ys: ys, xLeft: "Older", xRight: "Now", xMid: "" };
}

function pingSparkScaledRange(series) {
  let vmin = Infinity;
  let vmax = -Infinity;
  for (const v of series) {
    vmin = Math.min(vmin, v);
    vmax = Math.max(vmax, v);
  }
  if (!Number.isFinite(vmin) || !Number.isFinite(vmax)) return null;
  let span = vmax - vmin;
  if (span <= 1e-9) {
    vmin = Math.max(0, vmin - 2);
    vmax = vmax + 2;
    span = vmax - vmin;
  } else {
    const padV = span * 0.08;
    vmin -= padV;
    vmax += padV;
    span = vmax - vmin;
  }
  return { vmin: vmin, vmax: vmax, span: span };
}

/** Plot SVG only (axes labels live in HTML so width/height can stretch independently). */
function buildPingSparkPlotSvg(model, rng, opts) {
  opts = opts || {};
  const showYMidTick = opts.showYMidTick === true;
  const ns = "http://www.w3.org/2000/svg";
  const series = model.ys;
  const vmin = rng.vmin;
  const vmax = rng.vmax;
  const span = rng.span;

  const W = PING_SPARK_VB_WIDTH;
  const H = PING_SPARK_VB_HEIGHT;
  const ml = 14;
  const mr = 10;
  const mt = 12;
  const mb = 10;
  const cw = W - ml - mr;
  const ch = H - mt - mb;
  const xl = ml;
  const xr = W - mr;
  const yt = mt;
  const yb = H - mb;

  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 " + W + " " + H);
  svg.setAttribute("class", "overview-ping-spark-plot");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "100%");

  const n = series.length;
  function bx(i) {
    return n <= 1 ? xl + cw / 2 : xl + (cw * i) / (n - 1);
  }
  function byVal(vv) {
    return yt + (1 - (vv - vmin) / span) * ch;
  }

  const border = themeColor("--evu-border", "hsl(220 6% 20%)");
  const seriesStroke = themeColor("--evu-secondary", "hsl(217 80% 68%)");
  const seriesFill = themeColor("--evu-primary", "hsl(246 76% 68%)");

  const gridGrp = document.createElementNS(ns, "g");
  gridGrp.setAttribute("class", "overview-ping-spark-grid");
  for (let g = 1; g <= 3; g++) {
    const gy = yt + (ch * g) / 4;
    const hl = document.createElementNS(ns, "line");
    hl.setAttribute("x1", String(xl));
    hl.setAttribute("x2", String(xr));
    hl.setAttribute("y1", String(gy));
    hl.setAttribute("y2", String(gy));
    hl.setAttribute("stroke", border);
    hl.setAttribute("stroke-width", "1");
    hl.setAttribute("vector-effect", "non-scaling-stroke");
    gridGrp.appendChild(hl);
  }
  svg.appendChild(gridGrp);

  let poly = bx(0) + "," + yb + " ";
  for (let i = 0; i < n; i++) {
    poly += bx(i) + "," + byVal(series[i]) + " ";
  }
  poly += bx(n - 1) + "," + yb;

  const fill = document.createElementNS(ns, "polygon");
  fill.setAttribute("points", poly.trim());
  fill.setAttribute("fill", seriesFill);
  fill.setAttribute("fill-opacity", "0.15");
  svg.appendChild(fill);

  let linePts = "";
  for (let i = 0; i < n; i++) {
    linePts += bx(i) + "," + byVal(series[i]) + " ";
  }
  const pl = document.createElementNS(ns, "polyline");
  pl.setAttribute("fill", "none");
  pl.setAttribute("stroke", seriesStroke);
  pl.setAttribute("stroke-width", "2");
  pl.setAttribute("stroke-linecap", "round");
  pl.setAttribute("stroke-linejoin", "round");
  pl.setAttribute("vector-effect", "non-scaling-stroke");
  pl.setAttribute("points", linePts.trim());
  svg.appendChild(pl);

  const axY = document.createElementNS(ns, "path");
  axY.setAttribute("d", "M " + xl + " " + yt + " V " + yb + "");
  axY.setAttribute("fill", "none");
  axY.setAttribute("stroke", border);
  axY.setAttribute("stroke-width", "1");
  axY.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(axY);

  const axX = document.createElementNS(ns, "path");
  axX.setAttribute("d", "M " + xl + " " + yb + " H " + xr + "");
  axX.setAttribute("fill", "none");
  axX.setAttribute("stroke", border);
  axX.setAttribute("stroke-width", "1");
  axX.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(axX);

  const tickLen = 4;
  const tyTop = document.createElementNS(ns, "path");
  tyTop.setAttribute("d", "M " + (xl - tickLen) + " " + yt + " H " + xl + "");
  tyTop.setAttribute("stroke", border);
  tyTop.setAttribute("stroke-width", "1");
  tyTop.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(tyTop);

  const tyBot = document.createElementNS(ns, "path");
  tyBot.setAttribute("d", "M " + (xl - tickLen) + " " + yb + " H " + xl + "");
  tyBot.setAttribute("stroke", border);
  tyBot.setAttribute("stroke-width", "1");
  tyBot.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(tyBot);

  if (showYMidTick) {
    const yMidPx = yt + ch / 2;
    const tyMid = document.createElementNS(ns, "path");
    tyMid.setAttribute("d", "M " + (xl - tickLen) + " " + yMidPx + " H " + xl + "");
    tyMid.setAttribute("stroke", border);
    tyMid.setAttribute("stroke-width", "1");
    tyMid.setAttribute("vector-effect", "non-scaling-stroke");
    svg.appendChild(tyMid);
  }

  return svg;
}

/** HTML grid + unstretched typography; plot layer fills allocated height. */
function domPingSparkChart(model) {
  const rng = pingSparkScaledRange(model.ys);
  if (!rng) {
    const err = document.createElement("div");
    err.className = "overview-ping-spark-empty meta";
    err.textContent = "Could not derive latency axis range.";
    return err;
  }

  const yFmtTop = Math.round(rng.vmax);
  const yFmtBot = Math.round(rng.vmin);
  const yFmtMid = Math.round((rng.vmin + rng.vmax) / 2);
  const showYMid = yFmtTop !== yFmtBot && yFmtMid !== yFmtTop && yFmtMid !== yFmtBot;

  let ariaLatMid = "";
  if (showYMid) ariaLatMid = "; latency midpoint ~" + yFmtMid + " ms";

  const aria =
    "Average peer latency spark: " +
    model.ys.length +
    " buckets from " +
    (model.xLeft || "?") +
    " to " +
    (model.xRight || "?") +
    (model.xMid ? ", time midpoint " + model.xMid : "") +
    ariaLatMid;

  const shell = document.createElement("div");
  shell.className = "overview-ping-spark-layout";
  shell.setAttribute("role", "img");
  shell.setAttribute("aria-label", aria);

  const yAxis = document.createElement("div");
  yAxis.className = "overview-ping-spark-y-axis";
  yAxis.setAttribute("aria-hidden", "true");

  function yLbl(ms) {
    const el = document.createElement("div");
    el.className = "overview-ping-spark-y-tick";
    el.textContent = ms + " ms";
    return el;
  }

  if (yFmtTop === yFmtBot) {
    yAxis.classList.add("overview-ping-spark-y-axis-single");
    yAxis.appendChild(yLbl(yFmtTop));
  } else {
    yAxis.appendChild(yLbl(yFmtTop));
    if (showYMid) yAxis.appendChild(yLbl(yFmtMid));
    yAxis.appendChild(yLbl(yFmtBot));
  }

  const plotWrap = document.createElement("div");
  plotWrap.className = "overview-ping-spark-plot-wrap";
  plotWrap.appendChild(buildPingSparkPlotSvg(model, rng, { showYMidTick: showYMid }));

  const xAxis = document.createElement("div");
  xAxis.className = "overview-ping-spark-x-axis meta";
  xAxis.setAttribute("aria-hidden", "true");

  const xInner = document.createElement("div");
  xInner.className = "overview-ping-spark-x-row";

  const xStart = document.createElement("span");
  xStart.className = "overview-ping-spark-x-start";
  xStart.textContent = model.xLeft || "";

  const xMid = document.createElement("span");
  xMid.className = "overview-ping-spark-x-mid";
  xMid.textContent = model.xMid || "";

  const xEnd = document.createElement("span");
  xEnd.className = "overview-ping-spark-x-end";
  xEnd.textContent = model.xRight || "";

  xInner.appendChild(xStart);
  xInner.appendChild(xMid);
  xInner.appendChild(xEnd);
  xAxis.appendChild(xInner);

  const xCap = document.createElement("div");
  xCap.className = "overview-ping-spark-x-caption meta";
  xCap.textContent = "Time (UTC)";
  xCap.setAttribute("aria-hidden", "true");

  shell.appendChild(yAxis);
  shell.appendChild(plotWrap);
  shell.appendChild(xAxis);
  shell.appendChild(xCap);
  return shell;
}

function appendPingSparkInto(containerEl, met) {
  const model = pingSparkChartModel(met);
  if (model.ys.length < 2) {
    const p = document.createElement("p");
    p.className = "meta overview-ping-spark-empty";
    if (met && met.collection_disabled) {
      p.textContent = "Turn on ICMP peer metrics collection to build a latency history.";
    } else if (!model.ys.length) {
      p.textContent = "Historical averages appear once the collector fills a short window (~15 min · 1 min buckets).";
    } else {
      p.textContent = "Sparkline appears after two or more buckets of samples.";
    }
    containerEl.appendChild(p);
    return;
  }
  containerEl.appendChild(domPingSparkChart(model));
}

function overviewLatencyOverviewCard(met) {
  const wrap = document.createElement("div");
  wrap.id = "overview-latency-card";
  wrap.className = "evu-card card overview-dash-card overview-dash-latency";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Peer ICMP latency summary and rolling average chart");

  const h = document.createElement("h3");
  h.textContent = "Peer ICMP latency";
  wrap.appendChild(h);

  const disabled = !!(met && met.collection_disabled);
  const dash = met && met.dashboard ? met.dashboard : null;
  const lpTxt = formatDashboardMinAvgMax(dash && dash.last_ping, disabled);
  const l10Txt = formatDashboardMinAvgMax(dash && dash.last_10m, disabled);

  const line = document.createElement("div");
  line.className = "meta overview-latency-line";

  const segPing = document.createElement("span");
  segPing.className = "overview-latency-seg";
  const rk1 = document.createElement("span");
  rk1.className = "overview-latency-key";
  rk1.textContent = "Last ping";
  const rv1 = document.createElement("span");
  rv1.className = "overview-latency-val";
  rv1.textContent = lpTxt;
  segPing.appendChild(rk1);
  segPing.appendChild(rv1);

  const sep = document.createElement("span");
  sep.className = "overview-latency-sep meta";
  sep.textContent = "·";

  const seg10 = document.createElement("span");
  seg10.className = "overview-latency-seg";
  const rk2 = document.createElement("span");
  rk2.className = "overview-latency-key";
  rk2.textContent = "Last 10 min";
  const rv2 = document.createElement("span");
  rv2.className = "overview-latency-val";
  rv2.textContent = l10Txt;
  seg10.appendChild(rk2);
  seg10.appendChild(rv2);

  line.appendChild(segPing);
  line.appendChild(sep);
  line.appendChild(seg10);
  wrap.appendChild(line);

  const cap = document.createElement("p");
  cap.className = "meta overview-spark-caption";
  cap.textContent = "Rolling avg across peers (≈last 15 min · 1 min buckets)";
  wrap.appendChild(cap);

  const cc = document.createElement("div");
  cc.className = "overview-ping-spark-wrap";
  appendPingSparkInto(cc, met);
  wrap.appendChild(cc);
  return wrap;
}

function overviewHostGeoCard(o) {
  const wrap = document.createElement("div");
  wrap.className = "evu-card card overview-dash-card overview-dash-host";

  const h = document.createElement("h3");
  h.textContent = "Tunnel, forwarding & geo";
  wrap.appendChild(h);

  const grid = document.createElement("div");
  grid.className = "overview-kv-grid";

  function addRow(label, valueText, valueTitleOpt) {
    const lab = document.createElement("div");
    lab.className = "overview-kv-label";
    lab.textContent = label;
    const val = document.createElement("div");
    val.className = "overview-kv-val";
    val.textContent = valueText;
    if (valueTitleOpt) val.setAttribute("title", valueTitleOpt);
    grid.appendChild(lab);
    grid.appendChild(val);
  }

  function addStructuredValueRow(label, valueRoot) {
    const lab = document.createElement("div");
    lab.className = "overview-kv-label";
    lab.textContent = label;
    valueRoot.classList.add("overview-kv-val");
    grid.appendChild(lab);
    grid.appendChild(valueRoot);
  }

  function buildGeoFreshnessCell(geo) {
    const iso = geo && geo.geo_last_success_utc ? String(geo.geo_last_success_utc) : "";
    const root = document.createElement("div");
    root.className = "overview-geo-fresh";

    if (!iso) {
      const tag = document.createElement("span");
      tag.className = "overview-geo-fresh-tag overview-geo-fresh-tag--never";
      tag.textContent = "Never loaded";
      const hint = document.createElement("div");
      hint.className = "overview-geo-fresh-meta";
      hint.textContent = "Run Update geo lists from the Overview actions.";
      root.appendChild(tag);
      root.appendChild(hint);
      return root;
    }

    const d = Date.parse(iso);
    const stale = !isNaN(d) && Date.now() - d > GEO_STALE_MS;
    const src = String((geo && geo.geo_last_success_source) || "").trim();

    const tag = document.createElement("span");
    tag.className =
      "overview-geo-fresh-tag " +
      (stale ? "overview-geo-fresh-tag--stale" : "overview-geo-fresh-tag--ok");
    tag.textContent = stale ? "Stale" : "Up to date";

    const ageLine = document.createElement("span");
    ageLine.className = "overview-geo-fresh-age";
    ageLine.innerHTML = "Loaded " + timeHtml(iso);

    const head = document.createElement("div");
    head.className = "overview-geo-fresh-head";
    head.appendChild(tag);
    head.appendChild(ageLine);

    const meta = document.createElement("div");
    meta.className = "overview-geo-fresh-meta";

    if (src) {
      const srcSpan = document.createElement("span");
      srcSpan.textContent = "Source: " + geoSourceLabel(src);
      meta.appendChild(srcSpan);
    }

    root.appendChild(head);
    root.appendChild(meta);
    return root;
  }

  const iface = String(o.wireguard_interface ?? "—");
  const port = o.wireguard_listen_port ?? "—";

  const wgStack = document.createElement("div");
  wgStack.className = "overview-kv-wg-stack";
  wgStack.setAttribute("title", iface + " · UDP " + String(port));
  const wgIface = document.createElement("div");
  wgIface.className = "overview-kv-wg-iface";
  wgIface.textContent = iface;
  const wgListen = document.createElement("div");
  wgListen.className = "overview-kv-wg-listen";
  wgListen.textContent = "UDP " + String(port);
  wgStack.appendChild(wgIface);
  wgStack.appendChild(wgListen);
  addStructuredValueRow("WireGuard", wgStack);

  addRow("Public NIC", String(o.public_interface ?? "—"));
  addRow("Peers", String((o.peer_names || []).length));
  const n = (o.forwarding_routes && o.forwarding_routes.length) || 0;
  addRow("Forwarding", n + " route(s)");

  let geoLine = "off";
  let geoTitle = "";
  if (o.geo_enabled) {
    const prefix = o.geo_mode === "block" ? "block " : "allow ";
    const cc = Array.isArray(o.geo_countries) ? o.geo_countries : [];
    geoLine = prefix + cc.join(", ");
    if (cc.length > 3) {
      geoLine = prefix + cc.slice(0, 3).join(", ") + ", ...";
      geoTitle = prefix + cc.join(", ");
    }
  }
  addRow("Geo", geoLine, geoTitle || undefined);

  if (o.geo_enabled) {
    // Full width rather than a KV pair: the value is a stack that the narrow
    // value column would break onto five lines.
    const lab = document.createElement("div");
    lab.className = "overview-kv-label overview-geo-fresh-label";
    lab.textContent = "Geo zones freshness";
    grid.appendChild(lab);
    grid.appendChild(buildGeoFreshnessCell(o));
  }

  wrap.appendChild(grid);
  return wrap;
}

/** The newest apply-related event as "Applied config · 2h ago", with any detail below it. */
function appendApplySummary(root, evs) {
  const line = document.createElement("p");
  line.className = "meta";
  line.textContent = "No recent apply or geo events in the last fetch.";
  root.appendChild(line);
  const list = evs || [];
  for (const e of list) {
    const ev = (e && e.event) || "";
    if (
      ev === "reload_ok" ||
      ev === "reload_failed" ||
      ev === "update_geo_ok" ||
      ev === "update_geo_failed" ||
      ev === "backup_ok" ||
      ev === "restore_ok"
    ) {
      line.innerHTML = escapeHtml(eventLabel(ev)) + " · " + timeHtml(e.ts);
      if (eventDetail(e)) {
        const detail = document.createElement("p");
        detail.className = "meta";
        detail.textContent = eventDetail(e);
        root.appendChild(detail);
      }
      break;
    }
  }
}

/** Theme panel used for the two groups nested inside the activity card. */
function activityPane(title) {
  const root = document.createElement("section");
  root.className = "evu-panel overview-activity-pane";
  const head = document.createElement("div");
  head.className = "evu-panel__head";
  const h = document.createElement("h3");
  h.className = "overview-pane-title";
  h.textContent = title;
  head.appendChild(h);
  const body = document.createElement("div");
  body.className = "evu-panel__body";
  root.appendChild(head);
  root.appendChild(body);
  return { root, body };
}

function overviewActivityAttentionCard(evs, items) {
  const wrap = document.createElement("div");
  wrap.className = "evu-card card overview-dash-card overview-dash-activity";

  const inner = document.createElement("div");
  inner.className = "overview-activity-merge-inner";

  const left = activityPane("Last apply activity");
  appendApplySummary(left.body, evs);

  const right = activityPane(items.length ? "Needs attention" : "Status");
  if (!items.length) {
    const ok = document.createElement("p");
    ok.className = "meta";
    ok.textContent = "No warnings from this pass.";
    right.body.appendChild(ok);
  } else {
    const ul = document.createElement("ul");
    ul.className = "attention-list";
    for (const txt of items) {
      const li = document.createElement("li");
      li.textContent = txt;
      ul.appendChild(li);
    }
    right.body.appendChild(ul);
  }

  inner.appendChild(left.root);
  inner.appendChild(right.root);
  wrap.appendChild(inner);
  return wrap;
}

const FIRST_RUN_KEY = "evuproxy_first_run";

/**
 * Setup checklist. It appears while there are no peers and stays through the
 * route and apply steps, until a peer exists and nothing is left to apply. An
 * established host that later gains a pending edit never sees it.
 */
function firstRunChecklistCard(cfg, pending) {
  const peers = (cfg.peers || []).length;
  const routes = ((cfg.forwarding && cfg.forwarding.routes) || []).length;
  if (!peers) localStorage.setItem(FIRST_RUN_KEY, "1");
  else if (pending && !pending.pending) localStorage.removeItem(FIRST_RUN_KEY);
  if (!localStorage.getItem(FIRST_RUN_KEY)) return null;

  const endpoint = String((state.lastUIPrefs && state.lastUIPrefs.wireguard_server_endpoint) || "").trim();
  const steps = [
    { title: "Set the server endpoint", hint: "The public host:port that clients connect to.", href: "#/settings", done: !!endpoint },
    { title: "Add a peer", hint: "A machine on the tunnel that will receive traffic.", href: "#/peers", done: peers > 0 },
    { title: "Add a route", hint: "Forward a public port to that peer.", href: "#/routes", done: routes > 0 },
    { title: "Apply", hint: "Saved changes reach the host only when you apply them.", href: "#/pending", done: false },
  ];

  const wrap = document.createElement("div");
  wrap.className = "evu-card card overview-dash-card overview-first-run";
  const h = document.createElement("h3");
  h.textContent = "Get started";
  wrap.appendChild(h);
  const ol = document.createElement("ol");
  ol.className = "first-run-steps";
  for (const step of steps) {
    const li = document.createElement("li");
    li.className = step.done ? "first-run-step is-done" : "first-run-step";
    const a = document.createElement("a");
    a.href = step.href;
    a.textContent = step.title;
    li.appendChild(a);
    if (step.done) {
      const sr = document.createElement("span");
      sr.className = "evu-sr-only";
      sr.textContent = " (done)";
      li.appendChild(sr);
    }
    const hint = document.createElement("p");
    hint.className = "meta";
    hint.textContent = step.hint;
    li.appendChild(hint);
    ol.appendChild(li);
  }
  wrap.appendChild(ol);
  return wrap;
}

/** Routes have no name of their own, so identify them by the ports operators recognise. */
function routeLabel(r) {
  const ports = (r.ports || []).join(", ");
  if (!ports) return "A route";
  return "The route on port" + ((r.ports || []).length > 1 ? "s " : " ") + ports;
}

function buildOverviewAttentionItems(cfg, o, st, met) {
  const items = [];
  const peers = (cfg && cfg.peers) || [];
  const pubMap = wgPeerPubKeyMap(st);
  for (const p of peers) {
    if (p.disabled) continue;
    const row = pubMap.get((p.public_key || "").trim());
    const h = row && row.latest_handshake_unix;
    if (!h || h <= 0) {
      items.push('Peer "' + (p.name || "unnamed") + '" has no WireGuard handshake yet.');
    } else if (Math.floor(Date.now() / 1000) - h > PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC) {
      items.push('Peer "' + (p.name || "unnamed") + '" looks offline (stale handshake).');
    }
  }
  const disabledPeerByTunnel = new Map();
  for (const p of peers) {
    if (p.disabled) {
      const th = tunnelToHost(p.tunnel_ip);
      if (th) disabledPeerByTunnel.set(th, String(p.name || "").trim() || "unnamed");
    }
  }
  const routes = (cfg && cfg.forwarding && cfg.forwarding.routes) || [];
  for (const r of routes) {
    if (r.disabled) continue;
    const tip = String(r.target_ip || "").trim();
    if (tip && disabledPeerByTunnel.has(tip)) {
      items.push(
        routeLabel(r) + ' targets disabled peer "' + disabledPeerByTunnel.get(tip) + '" (' + tip + ").");
    }
  }
  if (met && !met.collection_disabled && (!met.peers || !met.peers.length)) {
    items.push("Peer metrics collection is enabled but no samples are stored yet.");
  }
  if (
    met &&
    met.collection_disabled !== true &&
    met.dashboard &&
    met.dashboard.last_10m &&
    typeof met.dashboard.last_10m.avg_ms === "number" &&
    met.dashboard.last_10m.avg_ms >= OVERVIEW_LATENCY_LAST10M_WARN_MS
  ) {
    items.push(
      "Average peer ICMP latency over the last 10 minutes is high (" +
        String(met.dashboard.last_10m.avg_ms) +
        " ms)."
    );
  }
  if (o && o.geo_enabled && !o.geo_last_success_utc) {
    items.push("Geoblocking is on but geo zone files have never loaded successfully on this host.");
  }
  if (cfg && cfg.forwarding && cfg.forwarding.maintenance_mode) {
    items.push("Maintenance mode is on — public forwards are disabled until you turn it off and Apply.");
  }
  for (const r of routes) {
    if (r.source_allow_cidrs && r.source_allow_cidrs.length) {
      items.push(routeLabel(r) + " restricts sources to an allowlist.");
    }
  }
  if (o && Array.isArray(o.host_warnings)) {
    for (const w of o.host_warnings) {
      const msg = w && (w.message || w.Message);
      if (msg) items.push(String(msg));
    }
  }
  return items;
}

export async function refreshOverviewPage() {
  const seq = ++state.overviewRefreshSeq;
  const grid = $("overview-cards");
  const msg = $("overview-action-msg");
  const actionsCard = $("overview-actions-card");
  if (!grid) return;
  msg.textContent = "";
  if (!token().trim()) {
    if (seq !== state.overviewRefreshSeq) return;
    state.apiConnectionOk = false;
    applyNavRestriction();
    setApiNotConnected();
    grid.innerHTML = "";
    grid.appendChild(
      overviewApiIssueCard({
        message: "Not connected: this browser has no API token yet.",
      })
    );
    if (actionsCard) actionsCard.hidden = true;
    const evCard0 = $("overview-events-card");
    if (evCard0) evCard0.hidden = true;
    return;
  }
  const doneLoading = beginLoading("overview-cards");
  try {
    try {
      await fetchUIPrefsFromServer();
    } catch (e) {
      /* keep state.lastUIPrefs; overview still useful */
    }
    const [o, met, cfg, st, evPack, pending] = await Promise.all([
      api("/v1/overview"),
      api("/v1/metrics/peers").catch(() => null),
      api("/v1/config").catch(() => null),
      api("/v1/stats").catch(() => null),
      api("/v1/events?limit=40").catch(() => ({ events: [] })),
      api("/v1/pending").catch(() => null),
    ]);
    const evs = (evPack && evPack.events) || [];
    if (seq !== state.overviewRefreshSeq) return;
    state.lastOverview = o;
    state.lastConfig = cfg || state.lastConfig;
    const maint = $("overview-maintenance-toggle");
    if (maint && cfg && cfg.forwarding) maint.checked = !!cfg.forwarding.maintenance_mode;
    state.apiConnectionOk = true;
    applyNavRestriction();
    setApiStatus(true);
    if (actionsCard) actionsCard.hidden = false;
    grid.innerHTML = "";
    const checklist = cfg && firstRunChecklistCard(cfg, pending);
    if (checklist) grid.appendChild(checklist);
    grid.appendChild(overviewActivityAttentionCard(evs, buildOverviewAttentionItems(cfg, o, st, met)));
    grid.appendChild(overviewHostGeoCard(o));
    grid.appendChild(overviewLatencyOverviewCard(met));
    void refreshOverviewEventsList();
  } catch (e) {
    if (seq !== state.overviewRefreshSeq) return;
    const errText = String(e.message || e);
    state.apiConnectionOk = false;
    applyNavRestriction();
    setApiStatus(false, errText);
    if (actionsCard) actionsCard.hidden = true;
    grid.innerHTML = "";
    grid.appendChild(
      overviewApiIssueCard({
        message:
          "There is a problem with the API: the EvuProxy API could not be reached or rejected this browser’s request.",
        detail: errText,
      })
    );
    const evUl = $("overview-events-list");
    const evEmpty = $("overview-events-empty");
    const evCard = $("overview-events-card");
    if (evUl) evUl.innerHTML = "";
    if (evEmpty) evEmpty.classList.remove("is-hidden");
    if (evCard) evCard.hidden = true;
  } finally {
    doneLoading();
  }
}

function setOverviewMsg(text, isErr) {
  const el = $("overview-action-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initOverviewPage() {
  const overviewMaint = $("overview-maintenance-toggle");
  if (overviewMaint) {
    overviewMaint.addEventListener("change", async () => {
      if (!state.lastConfig) return;
      const on = overviewMaint.checked;
      const saveMaintenance = (value) => (cfg) => {
        if (!cfg.forwarding) cfg.forwarding = {};
        cfg.forwarding.maintenance_mode = value;
      };
      const confirmation = (value) =>
        value
          ? "Maintenance mode saved. Public port forwards stop when you Apply."
          : "Maintenance mode off. Apply to restore forwards.";
      setOverviewMsg("…");
      try {
        await saveConfigEdit(saveMaintenance(on));
        setOverviewMsg("");
        refreshPendingBadge();
        showUndoToast(confirmation(on), {
          page: "overview",
          edit: saveMaintenance(!on),
          afterSave: (cfg, focus) => {
            setOverviewMsg("");
            refreshPendingBadge();
            overviewMaint.checked = !!(cfg.forwarding && cfg.forwarding.maintenance_mode);
            if (focus) overviewMaint.focus();
          },
          message: () => confirmation(!on),
        });
      } catch (e) {
        overviewMaint.checked = !!(state.lastConfig.forwarding && state.lastConfig.forwarding.maintenance_mode);
        setOverviewMsg(String(e.message || e), true);
      }
    });
  }

  const applyBtn = $("btn-apply");
  // Same host-mutating endpoint as Apply on Pending changes, so it gets the same
  // lockout gate. Leaving this one ungated would make the gate decorative —
  // maintenance mode is itself a lockout risk, and the copy next to this button
  // tells the operator to press it.
  async function applyWithLockoutCheck() {
    setOverviewMsg("Checking config…");
    const { res, error } = await fetchValidateResult();
    if (!res) {
      setOverviewMsg(error, true);
      return;
    }
    if (!res.ok) {
      setOverviewMsg("Config check failed; see Pending changes → Check config.", true);
      return;
    }
    const risks = lockoutRisks(res);
    if (risks.length) {
      const ip = res.detected_client_ip || "unknown";
      setOverviewMsg("Apply needs confirmation: this config may lock you out.", true);
      openConfirmModal({
        title: "Applying may lock you out",
        message:
          "Your connection appears as " +
          ip +
          ".\n\n" +
          lockoutRiskLines(risks).join("\n") +
          "\n\nOnly continue if you have another way back into this host.",
        confirmLabel: "Apply anyway",
        // Re-check on confirm: the dialog can sit open while another tab, the CLI
        // or another operator saves something else. The confirmation covers the
        // risks that were on screen, so a different set has to be read first.
        onConfirm: () => confirmedApply(lockoutSignature(risks)),
      });
      return;
    }
    await doApply();
  }

  async function confirmedApply(acknowledged) {
    setOverviewMsg("Checking config…");
    const { res, error } = await fetchValidateResult();
    if (!res) {
      setOverviewMsg(error, true);
      return;
    }
    if (!res.ok) {
      setOverviewMsg("Config check failed; see Pending changes → Check config.", true);
      return;
    }
    if (lockoutSignature(lockoutRisks(res)) !== acknowledged) {
      setOverviewMsg("The config changed since you confirmed. Press Apply to review again.", true);
      return;
    }
    await doApply();
  }

  async function doApply() {
    setOverviewMsg("…");
    try {
      await api("/v1/reload", { method: "POST" });
      setOverviewMsg("");
      await refreshOverviewPage();
      refreshPendingBadge();
      showToast("Applied to host");
    } catch (e) {
      setOverviewMsg(applyErrorText(e), true);
    }
  }

  applyBtn.addEventListener("click", async () => {
    if (applyBtn.disabled) return;
    applyBtn.disabled = true;
    try {
      await applyWithLockoutCheck();
    } finally {
      applyBtn.disabled = false;
    }
  });
  $("btn-geo").addEventListener("click", async () => {
    setOverviewMsg("…");
    try {
      await api("/v1/update-geo", { method: "POST" });
      setOverviewMsg("");
      showToast("Geo lists updated on host");
    } catch (e) {
      setOverviewMsg(String(e.message || e), true);
    }
  });

  const evCsv = $("overview-events-export-csv");
  if (evCsv) {
    evCsv.addEventListener("click", () => {
      downloadTextFile("evuproxy-events.csv", eventsToCsv(state.lastEventsForExport), "text/csv;charset=utf-8");
    });
  }
}
