import { state } from "../core/state.js";
import { $, escapeHtml, setApiStatus } from "../core/dom.js";
import { beginLoading } from "../core/loading.js";
import { api } from "../core/api.js";
import { tunnelToHost, tunnelHostOnly, routeProtoPlainText } from "../core/net.js";
import {
  wgPeerPubKeyMap,
  PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC,
  showPeersMetricsColumn,
  fetchPeerMetricsMap,
} from "../core/peers_data.js";

export function stopTopologyPolling() {
  if (state.topologyPollTimer) {
    clearInterval(state.topologyPollTimer);
    state.topologyPollTimer = null;
  }
}

function peerWgTopologyState(peer, st) {
  if (!peer) return "unknown";
  if (peer.disabled) return "na";
  if (!st || st.wireguard_dump_failed) return "unknown";
  const pk = String(peer.public_key || "").trim();
  const row = wgPeerPubKeyMap(st).get(pk);
  if (!row) return "unknown";
  const h = row.latest_handshake_unix;
  if (!h || h <= 0) return "off";
  const ago = Math.floor(Date.now() / 1000) - h;
  if (ago <= PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC) return "on";
  return "off";
}

function topologyPeerForHost(peers, host) {
  for (const p of peers) {
    if (tunnelToHost(p.tunnel_ip) === host) return p;
  }
  return null;
}

function topologyPeerKey(peer, host) {
  return peer ? String(peer.public_key || "").trim() || "peer-empty-key" : "orphan:" + host;
}

function buildTopologyPeerSlots(cfg, routes) {
  const peers = cfg.peers || [];
  const slots = [];
  const seen = new Set();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const host = String(r.target_ip || "").trim();
    const peer = topologyPeerForHost(peers, host);
    const key = topologyPeerKey(peer, host);
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ peer, orphanHost: peer ? "" : host, anchorRouteIndex: i, key });
  }
  return slots;
}

/* ——— Large configs ——— */

/** From here the whole graph no longer fits at a size anyone can read. Below it, nothing changes. */
const TOPO_SCALE_ROUTES = 16;
/** Width of the columns as drawn, in viewBox units. */
const TOPO_GRAPH_W = 780;

function topologyGroupExpanded(key) {
  return state.topologyFilter.trim() ? !state.topologyFilterCollapsed.has(key) : state.topologyExpanded.has(key);
}

function setTopologyGroupExpanded(key, open) {
  const filtering = !!state.topologyFilter.trim();
  const set = filtering ? state.topologyFilterCollapsed : state.topologyExpanded;
  if (open === filtering) set.delete(key);
  else set.add(key);
}

function routeMatchesTopologyFilter(r, peer, q) {
  const text = [
    r.name,
    routeProtoPlainText(r.proto),
    (r.ports || []).join(", "),
    r.target_ip,
    peer ? peer.name : "",
    peer ? peer.tunnel_ip : "",
  ].join(" ");
  return text.toLowerCase().includes(q);
}

/** Routes per peer, sorted by peer name so one can be found by eye. Peers with no route matching the filter are left out. */
function buildTopologyGroups(cfg) {
  const routes = (cfg.forwarding && cfg.forwarding.routes) || [];
  const peers = cfg.peers || [];
  const q = state.topologyFilter.trim().toLowerCase();
  const groups = new Map();
  for (const r of routes) {
    const host = String(r.target_ip || "").trim();
    const peer = topologyPeerForHost(peers, host);
    const key = topologyPeerKey(peer, host);
    let g = groups.get(key);
    if (!g) {
      g = { key, label: peer ? String(peer.name || "") : host, routes: [] };
      groups.set(key, g);
    }
    if (!q || routeMatchesTopologyFilter(r, peer, q)) g.routes.push(r);
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return [...groups.values()].filter((g) => g.routes.length).sort((a, b) => collator.compare(a.label, b.label));
}

/** What the graph draws per row: a route, or one stand-in for the routes of a collapsed peer. */
function topologyScaleRows(groups) {
  const rows = [];
  for (const g of groups) {
    if (topologyGroupExpanded(g.key)) {
      rows.push(...g.routes);
    } else {
      rows.push({
        topologyGroupCount: g.routes.length,
        proto: "",
        ports: g.routes.flatMap((r) => r.ports || []),
        target_ip: g.routes[0].target_ip,
        disabled: g.routes.every((r) => r.disabled),
      });
    }
  }
  return rows;
}

function routeCountText(n) {
  return n + (n === 1 ? " route" : " routes");
}

function topologyScaleSummaryText(groups, totalRoutes) {
  const shown = groups.reduce((n, g) => n + g.routes.length, 0);
  return state.topologyFilter.trim()
    ? shown + " of " + routeCountText(totalRoutes) + " match, on " + groups.length + " peer(s)"
    : routeCountText(totalRoutes) + " on " + groups.length + " peer(s)";
}

function syncTopologyScaleControls(atScale, groups, totalRoutes) {
  const controls = $("topology-scale-controls");
  if (!controls) return;
  controls.hidden = !atScale;
  if (!atScale) {
    $("topology-filter").value = "";
    return;
  }
  const text = topologyScaleSummaryText(groups, totalRoutes);
  // A status region: only a real change should be read out, not every poll.
  const summary = $("topology-scale-summary");
  if (summary.textContent !== text) summary.textContent = text;
}

/** viewBox at one screen pixel per unit, shrinking only if the wrap is narrower than the graph. */
function topologyScaleViewBox() {
  const wrap = $("topology-graph-wrap");
  const w = (wrap && wrap.clientWidth) || TOPO_GRAPH_W;
  const h = (wrap && wrap.clientHeight) || 480;
  const vw = Math.max(TOPO_GRAPH_W, w);
  return { vw, vh: Math.round((h * vw) / w) };
}

function redrawTopology() {
  const last = state.topologyLastRender;
  if (!last) return;
  renderTopologyGraph(last.cfg, last.st, last.activeKeys, last.pingByTunnel);
}

function peerSlotIndexForRoute(routes, slots, host) {
  const h = String(host || "").trim();
  for (let j = 0; j < slots.length; j++) {
    const s = slots[j];
    if (s.peer) {
      if (tunnelToHost(s.peer.tunnel_ip) === h) return j;
    } else if (s.orphanHost === h) {
      return j;
    }
  }
  return Math.max(0, slots.length - 1);
}

function routeTopologyProtoUpperEscaped(r) {
  const plain = routeProtoPlainText(r.proto);
  if (!plain || plain === "—") return "—";
  return escapeHtml(plain.toUpperCase());
}

/** Topology route card: show at most two ports, then ", ...". */
function routeTopologyPortsDisplayEscaped(r) {
  const ports = (r.ports || []).map((x) => String(x).trim()).filter(Boolean);
  if (ports.length === 0) return escapeHtml("—");
  if (r.topologyGroupCount) return escapeHtml(ports[0] + (ports.length > 1 ? ", ..." : ""));
  if (ports.length <= 2) return escapeHtml(ports.join(", "));
  return escapeHtml(ports.slice(0, 2).join(", ") + ", ...");
}

function routeTopologyAriaLabel(r) {
  const portsJoined = (r.ports || []).map((x) => String(x).trim()).filter(Boolean).join(", ");
  const ports = portsJoined || "—";
  if (r.topologyGroupCount) {
    return escapeHtml(routeCountText(r.topologyGroupCount) + " collapsed, ports " + ports + (r.disabled ? " (all disabled)" : ""));
  }
  const proto = routeProtoPlainText(r.proto);
  const name = String(r.name || "").trim();
  let s = "Forwarding route" + (name ? " " + name : "") + ", " + proto + ", ports " + ports;
  if (r.disabled) s += " (disabled)";
  return escapeHtml(s);
}

/** Ping display for topology peer cards (right column). */
function topologyPeerPingParts(peer, pingByTunnel) {
  if (!showPeersMetricsColumn()) {
    return { display: "—", title: "Enable peer ICMP metrics in Settings to show ping here." };
  }
  if (!peer) return { display: "—", title: "" };
  if (peer.disabled) return { display: "—", title: "Peer disabled" };
  if (!pingByTunnel) return { display: "…", title: "Loading metrics" };
  const th = tunnelHostOnly(peer.tunnel_ip);
  const row = th ? pingByTunnel.get(th) : null;
  if (!row) return { display: "—", title: "No ping data" };
  if (row.ok) return { display: String(row.latency_ms) + " ms", title: "Last ICMP ping (evuproxy metrics)" };
  const err = row.error ? String(row.error) : "unreachable";
  return { display: "—", title: err };
}

function topoBezierPath(x1, y1, x2, y2) {
  const dx = Math.max(40, (x2 - x1) * 0.45);
  return "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2;
}

/** Fallback width when DOM measure is unavailable. */
function estimateTopologyRouteChipWidthPx(r, routeX, peerX) {
  const proto = routeProtoPlainText(r.proto);
  const portsPlain = (r.ports || []).map((x) => String(x).trim()).filter(Boolean);
  const portsDisp =
    portsPlain.length === 0
      ? "—"
      : portsPlain.length <= 2
        ? portsPlain.join(", ")
        : portsPlain.slice(0, 2).join(", ") + ", ...";
  const protoU = proto === "—" ? "—" : proto.toUpperCase();
  const padAndGutter = 26;
  const border = 2;
  const splitGapAndVbar = 16;
  const w =
    border +
    padAndGutter +
    protoU.length * 7 +
    splitGapAndVbar +
    Math.max(portsDisp.length, 1) * 6.6 +
    padAndGutter;
  const maxW = Math.max(88, peerX - routeX - 24);
  return Math.max(68, Math.min(Math.ceil(w), maxW));
}

function buildTopologyRouteCardInnerHtml(r, protoEsc, portsEsc, aria, routeOutlineCls) {
  const name = String(r.name || "").trim();
  // A name replaces the protocol on the card; the protocol stays in the title and the label.
  const lead = r.topologyGroupCount
    ? '<span class="topology-route-proto">' + escapeHtml(routeCountText(r.topologyGroupCount)) + "</span>"
    : name
      ? '<span class="topology-route-name" title="' + escapeHtml(name) + " (" + protoEsc + ')">' + escapeHtml(name) + "</span>"
      : '<span class="topology-route-proto">' + protoEsc + "</span>";
  return (
    '<div class="topology-node topology-node--route' +
    (r.disabled ? " topology-node--disabled" : "") +
    routeOutlineCls +
    '" role="group" aria-label="' +
    aria +
    '"><div class="topology-route-split">' +
    lead +
    '<span class="topology-node-vbar" aria-hidden="true"></span><span class="topology-route-ports">' +
    portsEsc +
    "</span></div></div>"
  );
}

function measureTopologyRouteChipWidthPx(cardInnerHtml, routeX, peerX, r) {
  const wrap = $("topology-graph-wrap");
  const maxW = Math.max(88, peerX - routeX - 24);
  if (!wrap) {
    return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
  }
  let rail = $("topology-measure-rail");
  if (!rail) {
    rail = document.createElement("div");
    rail.id = "topology-measure-rail";
    rail.className = "topology-measure-rail";
    rail.setAttribute("aria-hidden", "true");
    wrap.appendChild(rail);
  }
  rail.innerHTML = cardInnerHtml;
  const node = rail.querySelector(".topology-node--route");
  if (!node) return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
  const w = node.getBoundingClientRect().width;
  if (!(w > 1)) return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
  return Math.max(52, Math.min(Math.ceil(w), maxW));
}

const TOPO_ZOOM_MIN = 0.25;
const TOPO_ZOOM_MAX = 4;

function topologyViewTransformStr() {
  return "translate(" + state.topologyPanX + "," + state.topologyPanY + ") scale(" + state.topologyZoomK + ")";
}

function applyTopologyPanZoomTransform(svg) {
  const g = svg.querySelector("#topology-pan-zoom-layer");
  if (g) g.setAttribute("transform", topologyViewTransformStr());
}

function resetTopologyView() {
  // At scale, the top of the graph at a readable size, rather than all of it as a sliver.
  state.topologyPanX = state.topologyAtScale ? (topologyScaleViewBox().vw - TOPO_GRAPH_W) / 2 : 0;
  state.topologyPanY = 0;
  state.topologyZoomK = 1;
  state.topologyPanDrag = null;
  const svg = $("topology-svg");
  if (svg) {
    applyTopologyPanZoomTransform(svg);
    svg.classList.remove("topology-svg--panning");
  }
}

function topologySvgPointFromClient(svg, clientX, clientY) {
  if (!svg || typeof svg.createSVGPoint !== "function") return null;
  const pt = svg.createSVGPoint();
  pt.x = clientX;
  pt.y = clientY;
  const m = svg.getScreenCTM();
  if (!m) return null;
  try {
    return pt.matrixTransform(m.inverse());
  } catch {
    return null;
  }
}

function topologyEventHitsForeignObject(e) {
  if (typeof e.composedPath === "function") {
    const path = e.composedPath();
    for (let i = 0; i < path.length; i++) {
      const n = path[i];
      if (n && String(n.tagName || "").toLowerCase() === "foreignobject") return true;
    }
  }
  let t = e.target;
  let hops = 0;
  while (t && hops++ < 64) {
    if (t.tagName && String(t.tagName).toLowerCase() === "foreignobject") return true;
    t =
      t.parentElement ||
      (t.parentNode && t.parentNode.nodeType === 1 ? t.parentNode : null);
  }
  return false;
}

function clampTopologyPanY(y, viewH) {
  const lowest = Math.min(0, viewH - state.topologyContentH * state.topologyZoomK);
  return Math.min(0, Math.max(lowest, y));
}

/** The limit a redraw applies, used by gestures too so the next poll has nothing to move. */
function limitTopologyPanY(y) {
  return state.topologyAtScale ? clampTopologyPanY(y, topologyScaleViewBox().vh) : y;
}

/** Moves a card reached by keyboard into view; the browser cannot scroll inside an SVG for us. */
function revealTopologyNode(svg, node) {
  const fo = node.closest("foreignObject");
  if (!fo || !state.topologyAtScale) return;
  const { vh } = topologyScaleViewBox();
  const k = state.topologyZoomK;
  const top = +fo.getAttribute("y") * k + state.topologyPanY;
  const bottom = top + +fo.getAttribute("height") * k;
  if (top >= 0 && bottom <= vh) return;
  state.topologyPanY = clampTopologyPanY(state.topologyPanY + (top < 0 ? -top : vh - bottom), vh);
  applyTopologyPanZoomTransform(svg);
}

let restoringTopologyFocus = false;

function initTopologyViewport() {
  const svg = $("topology-svg");
  if (!svg || svg.dataset.topologyViewportBound === "1") return;
  svg.dataset.topologyViewportBound = "1";

  svg.addEventListener(
    "wheel",
    (e) => {
      if (!svg.querySelector("#topology-pan-zoom-layer")) return;
      e.preventDefault();
      // A tall graph has to scroll like a page. Pinch gestures also arrive as ctrl+wheel.
      if (state.topologyAtScale && !e.ctrlKey && !e.metaKey) {
        const { vw, vh } = topologyScaleViewBox();
        const wrap = $("topology-graph-wrap");
        const unit = (e.deltaMode === 1 ? 16 : 1) * (vw / ((wrap && wrap.clientWidth) || vw));
        state.topologyPanX -= e.deltaX * unit;
        state.topologyPanY = clampTopologyPanY(state.topologyPanY - e.deltaY * unit, vh);
        applyTopologyPanZoomTransform(svg);
        return;
      }
      const p = topologySvgPointFromClient(svg, e.clientX, e.clientY);
      if (!p) return;
      const mx = p.x;
      const my = p.y;
      const scale = Math.exp(-e.deltaY * 0.002);
      let k2 = state.topologyZoomK * scale;
      if (k2 < TOPO_ZOOM_MIN) k2 = TOPO_ZOOM_MIN;
      if (k2 > TOPO_ZOOM_MAX) k2 = TOPO_ZOOM_MAX;
      const k1 = state.topologyZoomK;
      if (Math.abs(k2 - k1) < 1e-9) return;
      const r = k2 / k1;
      state.topologyZoomK = k2;
      state.topologyPanX = mx - r * (mx - state.topologyPanX);
      state.topologyPanY = limitTopologyPanY(my - r * (my - state.topologyPanY));
      applyTopologyPanZoomTransform(svg);
    },
    { passive: false }
  );

  svg.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    if (topologyEventHitsForeignObject(e)) return;
    if (!svg.querySelector("#topology-pan-zoom-layer")) return;
    e.preventDefault();
    const u0 = topologySvgPointFromClient(svg, e.clientX, e.clientY);
    if (!u0) return;
    state.topologyPanDrag = {
      pointerId: e.pointerId,
      u0,
      tx0: state.topologyPanX,
      ty0: state.topologyPanY,
    };
    try {
      svg.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    svg.classList.add("topology-svg--panning");
  });

  svg.addEventListener("pointermove", (e) => {
    if (!state.topologyPanDrag || e.pointerId !== state.topologyPanDrag.pointerId) return;
    const u = topologySvgPointFromClient(svg, e.clientX, e.clientY);
    if (!u) return;
    state.topologyPanX = state.topologyPanDrag.tx0 + (u.x - state.topologyPanDrag.u0.x);
    state.topologyPanY = limitTopologyPanY(state.topologyPanDrag.ty0 + (u.y - state.topologyPanDrag.u0.y));
    applyTopologyPanZoomTransform(svg);
  });

  function endPan(e) {
    if (!state.topologyPanDrag || e.pointerId !== state.topologyPanDrag.pointerId) return;
    state.topologyPanDrag = null;
    svg.classList.remove("topology-svg--panning");
    try {
      svg.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }

  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);

  svg.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest("[data-topo-toggle]");
    if (!btn) return;
    const key = btn.getAttribute("data-topo-toggle");
    setTopologyGroupExpanded(key, !topologyGroupExpanded(key));
    redrawTopology();
  });
  svg.addEventListener("focusin", (e) => {
    // Keyboard moves only. A redraw restoring focus must not pull the graph back to the toggle, and
    // moving a toggle out from under a mouse press would make the click miss it.
    if (restoringTopologyFocus || !e.target.matches(":focus-visible")) return;
    if (e.target.closest("[data-topo-toggle]")) revealTopologyNode(svg, e.target);
  });

  const wrap = $("topology-graph-wrap");
  if (wrap && typeof ResizeObserver === "function") {
    new ResizeObserver(() => {
      if (!state.topologyAtScale) return;
      const before = svg.viewBox.baseVal.width;
      const { vw, vh } = topologyScaleViewBox();
      svg.setAttribute("viewBox", "0 0 " + vw + " " + vh);
      state.topologyPanX += (vw - before) / 2;
      state.topologyPanY = clampTopologyPanY(state.topologyPanY, vh);
      applyTopologyPanZoomTransform(svg);
    }).observe(wrap);
  }
}

function renderTopologyGraph(cfg, st, activePeerKeys, pingByTunnel) {
  if (pingByTunnel === undefined) pingByTunnel = null;
  const svg = $("topology-svg");
  if (!svg) return;
  state.topologyLastRender = { cfg, st, activeKeys: activePeerKeys, pingByTunnel };
  const configRoutes = (cfg.forwarding && cfg.forwarding.routes) || [];
  const atScale = configRoutes.length >= TOPO_SCALE_ROUTES;
  if (!atScale) state.topologyFilter = "";
  const groups = atScale ? buildTopologyGroups(cfg) : [];
  const routesByGroup = new Map(groups.map((g) => [g.key, g.routes.length]));
  // Before the graph is measured: the controls take a line of the toolbar.
  syncTopologyScaleControls(atScale, groups, configRoutes.length);
  // An image has no interactive parts, and the collapse toggles have to be reachable.
  svg.setAttribute("role", atScale ? "group" : "img");
  if (atScale !== state.topologyAtScale) {
    state.topologyAtScale = atScale;
    resetTopologyView();
  }
  const routes = atScale ? topologyScaleRows(groups) : configRoutes;
  const slots = buildTopologyPeerSlots(cfg, routes);
  if (!routes.length) {
    const emptyText = atScale ? "No routes match this filter" : "No routes in config";
    svg.setAttribute("viewBox", "0 0 780 120");
    svg.innerHTML =
      '<title id="topology-svg-title">' +
      emptyText +
      '</title><g id="topology-pan-zoom-layer" class="topology-pan-zoom-layer">' +
      '<rect class="topology-grid-bg" x="0" y="0" width="780" height="120" fill="#000000" fill-opacity="0" stroke="none" aria-hidden="true" />' +
      '<text x="390" y="60" text-anchor="middle" class="topology-empty-text">' +
      emptyText +
      "</text></g>";
    // The pan is for the graph's own viewBox, and would move this message out of view.
    if (!atScale) applyTopologyPanZoomTransform(svg);
    return;
  }

  // Focus on a toggle would be lost with the markup; polls redraw under it too.
  const focusedEl = document.activeElement;
  const focusedToggle = focusedEl && svg.contains(focusedEl) ? focusedEl.getAttribute("data-topo-toggle") : null;

  const rowGapSamePeer = 52;
  const rowGapNewPeer = atScale ? 66 : 92;
  const peerNodeH = 58;
  const routeNodeH = 34;
  const rowH = Math.max(routeNodeH, peerNodeH);
  const pad = 36;

  const bandTop = [];
  for (let bi = 0; bi < routes.length; bi++) {
    if (bi === 0) bandTop[0] = pad;
    else {
      const pPrev = peerSlotIndexForRoute(routes, slots, routes[bi - 1].target_ip);
      const pCur = peerSlotIndexForRoute(routes, slots, routes[bi].target_ip);
      const step = pPrev === pCur ? rowGapSamePeer : rowGapNewPeer;
      bandTop[bi] = bandTop[bi - 1] + step;
    }
  }
  const lastBandTop = bandTop[routes.length - 1];
  const totalH = lastBandTop + rowH + 24;

  const srvW = 176;
  const srvX = 36;
  const srvCx = srvX + srvW;
  // At scale the middle of the graph is far off screen; keep the host at the top with the first rows.
  const srvCy = atScale ? pad + peerNodeH / 2 + 14 : totalH / 2;
  const routeX = 268;
  const peerX = 492;
  const peerW = 200;

  function routeMidY(i) {
    return bandTop[i] + rowH / 2;
  }

  const wgIf = (cfg.wireguard && cfg.wireguard.interface) || (st && st.wireguard_interface) || "wg0";
  const wgAddr = (cfg.wireguard && cfg.wireguard.address) || "";
  const pubIf = (cfg.network && cfg.network.public_interface) || "";
  const serverLineCount = 2 + (wgAddr ? 1 : 0) + (pubIf ? 1 : 0);
  const serverNodeH = Math.max(peerNodeH, 22 + serverLineCount * 19);

  const edges = [];
  const nodes = [];
  const routeCardInners = [];
  const routeWidths = [];
  const slotMaxRouteW = new Array(slots.length).fill(0);
  const routePeerSlot = [];
  for (let ri = 0; ri < routes.length; ri++) {
    const r0 = routes[ri];
    const protoEsc0 = routeTopologyProtoUpperEscaped(r0);
    const portsEsc0 = routeTopologyPortsDisplayEscaped(r0);
    const aria0 = routeTopologyAriaLabel(r0);
    const routeOutlineCls0 = r0.disabled ? "" : " topology-node--outline-on";
    const inner0 = buildTopologyRouteCardInnerHtml(r0, protoEsc0, portsEsc0, aria0, routeOutlineCls0);
    routeCardInners.push(inner0);
    const pj0 = peerSlotIndexForRoute(routes, slots, r0.target_ip);
    routePeerSlot.push(pj0);
    const w0 = measureTopologyRouteChipWidthPx(inner0, routeX, peerX, r0);
    if (w0 > slotMaxRouteW[pj0]) slotMaxRouteW[pj0] = w0;
  }
  for (let ri = 0; ri < routes.length; ri++) {
    routeWidths.push(slotMaxRouteW[routePeerSlot[ri]]);
  }

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const routeWi = routeWidths[i];
    const routeCx = routeX + routeWi;
    const rcy = routeMidY(i);
    const dis = !!r.disabled;
    const pj = peerSlotIndexForRoute(routes, slots, r.target_ip);
    const slot = slots[pj];
    const peer = slot && slot.peer;
    const pk = peer ? String(peer.public_key || "").trim() : "";
    const stt = peer ? peerWgTopologyState(peer, st) : "unknown";

    const p1 = topoBezierPath(srvCx, srvCy, routeX, rcy);
    const pathActive = !dis && stt === "on" && !!pk && activePeerKeys.has(pk);
    let e1c;
    let e2c;
    if (dis) {
      e1c = "topo-edge topo-edge--muted";
      e2c = "topo-edge topo-edge--muted";
    } else if (pathActive) {
      e1c = "topo-edge topo-edge--on topo-edge--pulse";
      e2c = "topo-edge topo-edge--on topo-edge--pulse";
    } else {
      e1c = "topo-edge topo-edge--neutral";
      e2c = "topo-edge topo-edge--neutral";
    }
    edges.push('<path class="' + e1c + '" d="' + p1 + '" fill="none" />');

    const peerAttachY = routeMidY(slots[pj].anchorRouteIndex);
    const p2 = topoBezierPath(routeCx, rcy, peerX, peerAttachY);
    edges.push('<path class="' + e2c + '" d="' + p2 + '" fill="none" />');
  }

  const serverBody =
    '<div class="topology-node topology-node--server"><p class="topology-node-title">EvuProxy</p>' +
    '<p class="topology-node-meta mono">' +
    escapeHtml(wgIf) +
    "</p>" +
    (wgAddr ? '<p class="topology-node-detail mono">' + escapeHtml(wgAddr) + "</p>" : "") +
    (pubIf
      ? '<p class="topology-node-detail meta">wan ' + escapeHtml(pubIf) + "</p>"
      : "") +
    "</div>";

  nodes.push(
    '<foreignObject x="' +
      srvX +
      '" y="' +
      (srvCy - serverNodeH / 2) +
      '" width="' +
      srvW +
      '" height="' +
      serverNodeH +
      '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--server">' +
      serverBody +
      "</div></foreignObject>"
  );

  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const ry = bandTop[i] + (rowH - routeNodeH) / 2;
    nodes.push(
      '<foreignObject x="' +
        routeX +
        '" y="' +
        ry +
        '" width="' +
        routeWidths[i] +
        '" height="' +
        routeNodeH +
        '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--route">' +
        routeCardInners[i] +
        "</div></foreignObject>"
    );
  }

  for (let j = 0; j < slots.length; j++) {
    const s = slots[j];
    const anchor = s.anchorRouteIndex;
    const py = bandTop[anchor] + (rowH - peerNodeH) / 2;
    const peer = s.peer;
    const stt = peer ? peerWgTopologyState(peer, st) : "unknown";
    const peerOutlineCls = stt === "on" ? " topology-node--outline-on" : "";

    const title = peer
      ? escapeHtml(String(peer.name || "").trim() || "Peer")
      : escapeHtml("Unknown target");
    const sub = peer
      ? escapeHtml(String(peer.tunnel_ip || "").trim())
      : escapeHtml(String(s.orphanHost || "").trim());
    const pingParts = topologyPeerPingParts(peer, pingByTunnel);
    const pingEsc = escapeHtml(pingParts.display);
    const pingTitleEsc = pingParts.title ? escapeHtml(pingParts.title) : "";
    const namePlain = peer ? String(peer.name || "").trim() || "Peer" : "Unknown target";
    const subPlain = peer ? String(peer.tunnel_ip || "").trim() : String(s.orphanHost || "").trim();
    const peerAria = escapeHtml(namePlain + ", " + subPlain + ", ping " + pingParts.display);
    const groupOpen = atScale && topologyGroupExpanded(s.key);
    const toggleHtml = atScale
      ? '<button type="button" class="topology-peer-toggle" data-topo-toggle="' +
        escapeHtml(s.key) +
        '" aria-expanded="' +
        groupOpen +
        '" aria-label="' +
        escapeHtml((groupOpen ? "Collapse " : "Expand ") + routeCountText(routesByGroup.get(s.key) || 0) + " to " + namePlain) +
        '"><span aria-hidden="true">' +
        (groupOpen ? "▾" : "▸") +
        "</span></button>"
      : "";

    nodes.push(
      '<foreignObject x="' +
        peerX +
        '" y="' +
        py +
        '" width="' +
        peerW +
        '" height="' +
        peerNodeH +
        '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--peer"><div class="topology-node topology-node--peer' +
        peerOutlineCls +
        '" role="group" aria-label="' +
        peerAria +
        '"><div class="topology-peer-split">' +
        toggleHtml +
        '<div class="topology-peer-main"><p class="topology-node-title">' +
        title +
        '</p><p class="topology-node-meta mono">' +
        sub +
        '</p></div><span class="topology-node-vbar" aria-hidden="true"></span><span class="topology-peer-ping mono"' +
        (pingTitleEsc ? ' title="' + pingTitleEsc + '"' : "") +
        ">" +
        pingEsc +
        "</span></div></div></div></foreignObject>"
    );
  }

  const online = slots.filter((s) => s.peer && peerWgTopologyState(s.peer, st) === "on").length;
  // At scale `routes` holds stand-ins for collapsed peers, so it does not count routes.
  const summary =
    (atScale
      ? topologyScaleSummaryText(groups, configRoutes.length)
      : routes.length + " route(s), " + slots.length + " peer target(s)") +
    ", " +
    online +
    " online peer link(s)";
  if (atScale) {
    const { vw, vh } = topologyScaleViewBox();
    svg.setAttribute("viewBox", "0 0 " + vw + " " + vh);
    state.topologyContentH = totalH;
    state.topologyPanY = clampTopologyPanY(state.topologyPanY, vh);
  } else {
    svg.setAttribute("viewBox", "0 0 780 " + totalH);
  }
  svg.innerHTML =
    '<title id="topology-svg-title">' +
    escapeHtml(summary) +
    '</title><g id="topology-pan-zoom-layer" class="topology-pan-zoom-layer"><rect class="topology-grid-bg" x="0" y="0" width="780" height="' +
    totalH +
    '" fill="#000000" fill-opacity="0" stroke="none" aria-hidden="true" /><g class="topology-edges" aria-hidden="true">' +
    edges.join("") +
    '</g><g class="topology-nodes">' +
    nodes.join("") +
    "</g></g>";
  applyTopologyPanZoomTransform(svg);
  if (focusedToggle) {
    const again = svg.querySelector('[data-topo-toggle="' + CSS.escape(focusedToggle) + '"]');
    if (again) {
      restoringTopologyFocus = true;
      again.focus({ preventScroll: true });
      restoringTopologyFocus = false;
    }
  }
}

/**
 * @param {{ background?: boolean }} [opts] `background` for the poll: the graph
 *   would otherwise read as busy, and dim on a slow link, every few seconds.
 */
export async function refreshTopologyPage(opts) {
  if (state.topologyRefreshInFlight) return;
  state.topologyRefreshInFlight = true;
  const doneLoading = opts && opts.background ? () => {} : beginLoading("topology-graph-wrap");
  const msg = $("topology-msg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("err");
  }
  try {
    const [cfg, st] = await Promise.all([api("/v1/config"), api("/v1/stats")]);
    let pingByTunnel = null;
    if (showPeersMetricsColumn()) {
      try {
        pingByTunnel = await fetchPeerMetricsMap();
        state.lastPeerPingByTunnel = pingByTunnel;
      } catch (_) {
        pingByTunnel = state.lastPeerPingByTunnel;
      }
    }
    const activeKeys = new Set();
    if (st && !st.wireguard_dump_failed && Array.isArray(st.wireguard_peers)) {
      for (const row of st.wireguard_peers) {
        const pk = String(row.public_key || "").trim();
        if (!pk) continue;
        const cur = (Number(row.transfer_rx) || 0) + (Number(row.transfer_tx) || 0);
        const prev = state.topologyPrevPeerBytes.get(pk);
        if (prev !== undefined && cur - prev >= 128) {
          activeKeys.add(pk);
        }
        state.topologyPrevPeerBytes.set(pk, cur);
      }
    }
    renderTopologyGraph(cfg, st, activeKeys, pingByTunnel);
    setApiStatus(true);
  } catch (e) {
    if (msg) {
      msg.textContent = String(e.message || e);
      msg.classList.add("err");
    }
    setApiStatus(false, String(e.message || e));
  } finally {
    state.topologyRefreshInFlight = false;
    doneLoading();
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initTopologyPage() {
  initTopologyViewport();
  const topoCenter = $("topology-center");
  if (topoCenter) topoCenter.addEventListener("click", resetTopologyView);
  const topoFilter = $("topology-filter");
  if (topoFilter) {
    topoFilter.addEventListener("input", () => {
      state.topologyFilter = topoFilter.value;
      state.topologyFilterCollapsed.clear();
      // A new result set starts from the top, or it can sit entirely above the view.
      state.topologyPanY = 0;
      redrawTopology();
    });
  }
  const setAllGroups = (open) => {
    const last = state.topologyLastRender;
    if (!last) return;
    for (const g of buildTopologyGroups(last.cfg)) setTopologyGroupExpanded(g.key, open);
    redrawTopology();
  };
  const expandAll = $("topology-expand-all");
  if (expandAll) expandAll.addEventListener("click", () => setAllGroups(true));
  const collapseAll = $("topology-collapse-all");
  if (collapseAll) collapseAll.addEventListener("click", () => setAllGroups(false));
}
