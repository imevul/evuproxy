import { state } from "../core/state.js";
import { $, escapeHtml, setApiStatus } from "../core/dom.js";
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

function buildTopologyPeerSlots(cfg) {
  const routes = (cfg.forwarding && cfg.forwarding.routes) || [];
  const peers = cfg.peers || [];
  const slots = [];
  const seen = new Set();
  for (let i = 0; i < routes.length; i++) {
    const r = routes[i];
    const host = String(r.target_ip || "").trim();
    let peer = null;
    for (const p of peers) {
      if (tunnelToHost(p.tunnel_ip) === host) {
        peer = p;
        break;
      }
    }
    const key = peer ? String(peer.public_key || "").trim() || "peer-empty-key" : "orphan:" + host;
    if (seen.has(key)) continue;
    seen.add(key);
    slots.push({ peer, orphanHost: peer ? "" : host, anchorRouteIndex: i });
  }
  return slots;
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
  if (ports.length <= 2) return escapeHtml(ports.join(", "));
  return escapeHtml(ports.slice(0, 2).join(", ") + ", ...");
}

function routeTopologyAriaLabel(r) {
  const proto = routeProtoPlainText(r.proto);
  const portsJoined = (r.ports || []).map((x) => String(x).trim()).filter(Boolean).join(", ");
  const ports = portsJoined || "—";
  let s = "Forwarding route, " + proto + ", ports " + ports;
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
  return (
    '<div class="topology-node topology-node--route' +
    (r.disabled ? " topology-node--disabled" : "") +
    routeOutlineCls +
    '" role="group" aria-label="' +
    aria +
    '"><div class="topology-route-split"><span class="topology-route-proto">' +
    protoEsc +
    '</span><span class="topology-node-vbar" aria-hidden="true"></span><span class="topology-route-ports">' +
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
  state.topologyPanX = 0;
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

function initTopologyViewport() {
  const svg = $("topology-svg");
  if (!svg || svg.dataset.topologyViewportBound === "1") return;
  svg.dataset.topologyViewportBound = "1";

  svg.addEventListener(
    "wheel",
    (e) => {
      if (!svg.querySelector("#topology-pan-zoom-layer")) return;
      e.preventDefault();
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
      state.topologyPanX = mx - r * (mx - state.topologyPanX);
      state.topologyPanY = my - r * (my - state.topologyPanY);
      state.topologyZoomK = k2;
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
    state.topologyPanY = state.topologyPanDrag.ty0 + (u.y - state.topologyPanDrag.u0.y);
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
}

function renderTopologyGraph(cfg, st, activePeerKeys, pingByTunnel) {
  if (pingByTunnel === undefined) pingByTunnel = null;
  const svg = $("topology-svg");
  if (!svg) return;
  const routes = (cfg.forwarding && cfg.forwarding.routes) || [];
  const slots = buildTopologyPeerSlots(cfg);
  if (!routes.length) {
    svg.setAttribute("viewBox", "0 0 780 120");
    svg.innerHTML =
      '<title id="topology-svg-title">No routes in config</title><g id="topology-pan-zoom-layer" class="topology-pan-zoom-layer">' +
      '<rect class="topology-grid-bg" x="0" y="0" width="780" height="120" fill="#000000" fill-opacity="0" stroke="none" aria-hidden="true" />' +
      '<text x="390" y="60" text-anchor="middle" class="topology-empty-text">No routes in config</text></g>';
    applyTopologyPanZoomTransform(svg);
    return;
  }

  const rowGapSamePeer = 52;
  const rowGapNewPeer = 92;
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
  const srvCy = totalH / 2;
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
        '"><div class="topology-peer-split"><div class="topology-peer-main"><p class="topology-node-title">' +
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
  const summary =
    routes.length +
    " route(s), " +
    slots.length +
    " peer target(s), " +
    online +
    " online peer link(s)";
  svg.setAttribute("viewBox", "0 0 780 " + totalH);
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
}

export async function refreshTopologyPage() {
  if (state.topologyRefreshInFlight) return;
  state.topologyRefreshInFlight = true;
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
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initTopologyPage() {
  initTopologyViewport();
  const topoRef = $("topology-refresh");
  if (topoRef) topoRef.addEventListener("click", () => void refreshTopologyPage());
  const topoCenter = $("topology-center");
  if (topoCenter) topoCenter.addEventListener("click", resetTopologyView);
}
