import { state } from "../core/state.js";
import {
  $,
  escapeHtml,
  setApiStatus,
  tableDisabledToggleCell,
  monoIpCopyCellHtml,
  bindTunnelIpCopyButtons,
  applyPeersRoutesTableFilter,
  writeRateLimitFields,
  readRateLimitFromForm,
} from "../core/dom.js";
import { api } from "../core/api.js";
import { tunnelToHost, parsePortsList, parseSourceAllowListInput, routeProtoPlainText } from "../core/net.js";
import { setRouteEditorTab, syncAdvancedTabsGating } from "../core/advanced.js";
import { openModal, closeModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

function expandRoutePortTokens(portsArr) {
  /** Keep in sync with internal/config/ports_expand.go ExpandRoutePortNumbers. */
  const MAX_DISTINCT = 65535;
  let over = false;
  const seen = new Set();
  const addPort = (p) => {
    const n = p | 0;
    if (n >= 1 && n <= 65535) {
      seen.add(n);
      if (seen.size > MAX_DISTINCT) {
        over = true;
      }
    }
  };
  const expandTok = (tok) => {
    tok = String(tok || "").trim();
    if (!tok) return;
    const i = tok.indexOf("-");
    if (i >= 0) {
      const a = +tok.slice(0, i).trim();
      const b = +tok.slice(i + 1).trim();
      if (!(a >= 1 && b <= 65535 && a <= b && a === (a | 0) && b === (b | 0))) return;
      for (let p = a; p <= b; p++) addPort(p);
    } else {
      const p = +tok;
      if (p >= 1 && p <= 65535 && p === (p | 0)) addPort(p);
    }
  };
  for (const raw of portsArr || []) {
    let s = String(raw || "").trim();
    if (!s) continue;
    if (s.startsWith("{") && s.endsWith("}")) {
      s = s.slice(1, -1);
      for (const part of s.split(",")) expandTok(part.trim());
    } else {
      expandTok(s);
    }
  }
  return over ? null : Array.from(seen).sort((a, b) => a - b);
}

export function closeRouteProbeModal() {
  state.routeProbePending = null;
  const m = $("route-probe-modal");
  if (m) closeModal(m);
}

function openRouteProbeModal(index) {
  const routes = state.lastConfig && state.lastConfig.forwarding && state.lastConfig.forwarding.routes;
  if (!routes || routes[index] === undefined) return;
  const r = routes[index];
  if (r.disabled) {
    setRoutesMsg("Route is disabled.", true);
    return;
  }
  const expanded = expandRoutePortTokens(r.ports);
  if (expanded === null) {
    setRoutesMsg("This route expands to too many distinct ports to pick one here.", true);
    return;
  }
  if (!expanded.length) {
    setRoutesMsg("Route has no ports.", true);
    return;
  }
  if (expanded.length === 1) {
    void runRouteProbeWithPort(index, expanded[0]);
    return;
  }
  state.routeProbePending = { index, portsSet: new Set(expanded) };
  const hint = $("route-probe-modal-hint");
  if (hint) {
    hint.innerHTML =
      "Target <span class=\"mono\">" +
      escapeHtml(String(r.target_ip || "")) +
      "</span> — " +
      escapeHtml(formatRouteProtoCell(r.proto)) +
      " — <strong>" +
      expanded.length +
      "</strong> ports.";
  }
  const num = $("route-probe-port-input");
  if (num) {
    num.value = String(expanded[0]);
    num.min = "1";
    num.max = "65535";
  }
  const modal = $("route-probe-modal");
  if (modal) {
    openModal(modal);
    if (num) requestAnimationFrame(() => num.focus());
  }
}

async function runRouteProbeWithPort(index, port) {
  setRoutesMsg("…");
  try {
    const body = { route_index: index, port: port | 0 };
    const res = await api("/v1/routes/test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const parts = (res.results || []).map(
      (r) => r.proto + " port " + r.port + ": " + r.status + (r.error_detail ? " — " + r.error_detail : "")
    );
    setRoutesMsg(parts.join("; ") || "No results.");
  } catch (e) {
    setRoutesMsg(String(e.message || e), true);
  }
}

function runRouteProbe(index) {
  openRouteProbeModal(index);
}

/* ——— Routes ——— */
function setRoutesMsg(text, isErr) {
  const el = $("routes-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function peerTunnelIPv4Options(cfg) {
  const sel = $("route-f-target");
  sel.innerHTML = "";
  (cfg.peers || []).forEach((p) => {
    if (p.disabled) return;
    const ip = tunnelToHost(p.tunnel_ip);
    if (!ip) return;
    const o = document.createElement("option");
    o.value = ip;
    const name = String(p.name || "").trim();
    o.textContent = name ? name + " (" + ip + ")" : ip;
    sel.appendChild(o);
  });
}

/** Peer display name whose tunnel IPv4 host equals route target_ip. */
function peerNameForTargetHost(cfg, hostIp) {
  const target = String(hostIp || "").trim();
  if (!target || !cfg || !cfg.peers) return "";
  for (const p of cfg.peers) {
    const h = tunnelToHost(p.tunnel_ip);
    if (h && h === target) {
      const n = String(p.name || "").trim();
      if (n) return n;
    }
  }
  return "";
}

function routeProtoFromCheckboxes() {
  const tcp = $("route-f-proto-tcp").checked;
  const udp = $("route-f-proto-udp").checked;
  if (tcp && udp) return "tcp,udp";
  if (tcp) return "tcp";
  if (udp) return "udp";
  return "";
}

function setRouteProtoCheckboxes(protoStr) {
  const s = String(protoStr || "").toLowerCase().trim();
  let tcp = false;
  let udp = false;
  if (s === "both") {
    tcp = true;
    udp = true;
  } else {
    const parts = s.split(/[,+\s]+/).map((x) => x.trim()).filter(Boolean);
    tcp = s === "tcp" || parts.includes("tcp");
    udp = s === "udp" || parts.includes("udp");
  }
  $("route-f-proto-tcp").checked = tcp;
  $("route-f-proto-udp").checked = udp;
}

function formatRouteProtoCell(p) {
  const plain = routeProtoPlainText(p);
  if (plain === "—") return "—";
  if (plain === "tcp" || plain === "udp" || plain === "tcp, udp") return plain;
  return escapeHtml(plain);
}

function renderRoutesTable(cfg) {
  const wrap = $("routes-table-wrap");
  const routes = (cfg.forwarding && cfg.forwarding.routes) || [];

  if (!routes.length) {
    wrap.innerHTML =
      "<div class=\"empty-state\"><span class=\"empty-state-msg\">No forwarding routes yet.</span> <button type=\"button\" class=\"btn-primary\" id=\"routes-empty-add\">Add route</button></div>";
    const addBtn = $("routes-empty-add");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const st = $("routes-add");
        if (st) st.click();
      });
    }
    return;
  }
  const rows = routes
    .map((r, i) => {
      const targetHost = String(r.target_ip || "").trim();
      const targetPeerName = peerNameForTargetHost(cfg, targetHost);
      const f = [formatRouteProtoCell(r.proto), (r.ports || []).join(", "), targetHost, targetPeerName].join(" ").toLowerCase();
      const srcList = r.source_allow_cidrs || [];
      const srcCell =
        srcList.length > 0
          ? '<td title="' +
            escapeHtml(srcList.join(", ")) +
            '"><span class="mono">' +
            escapeHtml(String(srcList.length)) +
            "</span> <span class=\"meta\">CIDR</span></td>"
          : '<td><span class="meta">any</span></td>';
      return (
        `<tr data-filter="${escapeHtml(f)}"><td>${formatRouteProtoCell(r.proto)}</td><td class="mono">${escapeHtml((r.ports || []).join(", "))}</td>` +
        monoIpCopyCellHtml(r.target_ip, targetPeerName) +
        `${srcCell}${tableDisabledToggleCell("data-route-disabled", i, !!r.disabled, "Enabled: route to " + String(r.target_ip || ""))}<td class="row-actions"><button type="button" data-route-test="${i}" class="btn-quiet">Test</button> <button type="button" data-route-edit="${i}">Edit</button> <button type="button" data-route-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      );
    })
    .join("");
  wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Ports</th><th>Target</th><th>Source</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  bindTunnelIpCopyButtons(wrap, setRoutesMsg);
  wrap.querySelectorAll("[data-route-edit]").forEach((b) => {
    b.addEventListener("click", () => openRouteEditor(+b.getAttribute("data-route-edit")));
  });
  wrap.querySelectorAll("[data-route-test]").forEach((b) => {
    b.addEventListener("click", () => runRouteProbe(+b.getAttribute("data-route-test")));
  });
  wrap.querySelectorAll("[data-route-del]").forEach((b) => {
    b.addEventListener("click", () => removeRoute(+b.getAttribute("data-route-del")));
  });
  wrap.querySelectorAll("input[data-route-disabled]").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("change", async () => {
      const idx = +inp.getAttribute("data-route-disabled");
      await patchRouteDisabled(idx, !inp.checked);
    });
  });
  applyPeersRoutesTableFilter();
}

function openRouteEditor(index) {
  const cfg = state.lastConfig;
  if (!cfg) return;
  if (!cfg.forwarding.routes) cfg.forwarding.routes = [];
  peerTunnelIPv4Options(cfg);
  const dis = $("route-f-disabled");
  if (dis) dis.checked = true;
  if (index === -1) {
    $("route-edit-index").value = "";
    $("route-editor-title").textContent = "Add route";
    setRouteProtoCheckboxes("tcp");
    $("route-f-ports").value = "";
    const sa0 = $("route-f-source-allow");
    if (sa0) sa0.value = "";
    const sd0 = $("route-f-source-deny");
    if (sd0) sd0.value = "";
    const gm0 = $("route-f-geo-mode");
    if (gm0) gm0.value = "inherit";
    const modeEl0 = $("route-f-port-map-mode");
    if (modeEl0) modeEl0.value = "same";
  } else {
    const r = cfg.forwarding.routes[index];
    if (!r) return;
    $("route-edit-index").value = String(index);
    $("route-editor-title").textContent = "Edit route";
    setRouteProtoCheckboxes(r.proto);
    $("route-f-ports").value = (r.ports || []).join(", ");
    $("route-f-target").value = r.target_ip || "";
    const sa = $("route-f-source-allow");
    if (sa) sa.value = (r.source_allow_cidrs || []).join(", ");
    const sd = $("route-f-source-deny");
    if (sd) sd.value = (r.source_deny_cidrs || []).join(", ");
    const gm = $("route-f-geo-mode");
    if (gm) gm.value = r.geo_mode || "inherit";
    const gc = $("route-f-geo-countries");
    if (gc) gc.value = (r.geo_countries || []).join(", ");
    loadRoutePortMapsToForm(r);
    writeRateLimitFields("route", r.rate_limit || {});
    if (dis) dis.checked = !r.disabled;
  }
  if (index === -1) writeRateLimitFields("route", {});
  setRouteEditorTab("default");
  syncAdvancedTabsGating();
  syncRoutePortMapModeUI();
  syncRouteGeoModeUI();
  const modal = $("route-modal");
  if (modal) {
    openModal(modal);
    const firstFocus = $("route-f-proto-tcp");
    if (firstFocus) requestAnimationFrame(() => firstFocus.focus());
  }
}

export function closeRouteEditor() {
  const modal = $("route-modal");
  if (modal) closeModal(modal);
}

function syncRoutePortMapModeUI() {
  const mode = ($("route-f-port-map-mode") && $("route-f-port-map-mode").value) || "same";
  const one = $("route-f-internal-one");
  const rows = $("route-port-map-rows");
  if (one) one.classList.toggle("is-hidden", mode !== "one");
  if (rows) rows.classList.toggle("is-hidden", mode !== "table");
  if (mode === "table") renderRoutePortMapRows();
}

function syncRouteGeoModeUI() {
  const gm = ($("route-f-geo-mode") && $("route-f-geo-mode").value) || "inherit";
  const gc = $("route-f-geo-countries");
  if (gc) {
    gc.classList.toggle("is-hidden", gm !== "custom");
    if (gm === "custom" && !gc.value.trim()) gc.placeholder = "se, no";
  }
}

function renderRoutePortMapRows(existingMaps) {
  const wrap = $("route-port-map-rows");
  if (!wrap) return;
  const ports = parsePortsList(($("route-f-ports") && $("route-f-ports").value) || "");
  const byPub = {};
  (existingMaps || []).forEach((m) => {
    if (m && m.public) byPub[m.public] = m.internal || "";
  });
  wrap.innerHTML = ports
    .map(
      (p) =>
        '<div class="route-port-map-row field"><span class="meta">' +
        escapeHtml(p) +
        ' →</span><input type="text" class="route-port-map-internal" data-public="' +
        escapeHtml(p) +
        '" placeholder="internal port" value="' +
        escapeHtml(byPub[p] || "") +
        '" autocomplete="off" /></div>'
    )
    .join("");
}

function readPortMapsFromForm(ports) {
  const mode = ($("route-f-port-map-mode") && $("route-f-port-map-mode").value) || "same";
  if (mode === "same") return undefined;
  if (mode === "one") {
    const internal = ($("route-f-internal-one") && $("route-f-internal-one").value.trim()) || "";
    if (!internal) return undefined;
    return ports.map((p) => ({ public: p, internal }));
  }
  const maps = [];
  wrapQueryPortMapRows().forEach((inp) => {
    const pub = inp.getAttribute("data-public") || "";
    const internal = inp.value.trim();
    if (pub && internal) maps.push({ public: pub, internal });
  });
  return maps.length ? maps : undefined;
}

function wrapQueryPortMapRows() {
  const wrap = $("route-port-map-rows");
  if (!wrap) return [];
  return Array.from(wrap.querySelectorAll(".route-port-map-internal"));
}

function loadRoutePortMapsToForm(r) {
  const maps = r.port_maps || [];
  const modeEl = $("route-f-port-map-mode");
  const oneEl = $("route-f-internal-one");
  if (!modeEl) return;
  if (!maps.length) {
    modeEl.value = "same";
  } else if (maps.length === 1 && parsePortsList(($("route-f-ports") && $("route-f-ports").value) || "").length > 1) {
    const allSame = maps.every((m) => m.internal === maps[0].internal);
    if (allSame && maps.length === parsePortsList(($("route-f-ports") && $("route-f-ports").value) || "").length) {
      modeEl.value = "one";
      if (oneEl) oneEl.value = maps[0].internal;
    } else {
      modeEl.value = "table";
    }
  } else {
    modeEl.value = "table";
  }
  renderRoutePortMapRows(maps);
  syncRoutePortMapModeUI();
}

async function patchRouteDisabled(index, disabled) {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.forwarding || !cfg.forwarding.routes || cfg.forwarding.routes[index] === undefined) return;
  cfg.forwarding.routes[index].disabled = disabled;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setRoutesMsg("");
    setApiStatus(true);
    refreshPendingBadge();
    renderRoutesTable(cfg);
  } catch (e) {
    setRoutesMsg(String(e.message || e), true);
    renderRoutesTable(state.lastConfig);
  }
}

async function saveRouteEditor() {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.forwarding) cfg.forwarding = {};
  if (!cfg.forwarding.routes) cfg.forwarding.routes = [];
  const proto = routeProtoFromCheckboxes();
  const ports = parsePortsList($("route-f-ports").value);
  const target = $("route-f-target").value.trim();
  if (!proto) {
    setRoutesMsg("Select at least one protocol (TCP and/or UDP).", true);
    return;
  }
  if (!ports.length || !target) {
    setRoutesMsg("Ports and target are required.", true);
    return;
  }
  const routeEn = $("route-f-disabled");
  const srcList = parseSourceAllowListInput(($("route-f-source-allow") && $("route-f-source-allow").value) || "");
  const entry = {
    proto,
    ports,
    target_ip: target,
    disabled: !(routeEn && routeEn.checked),
    source_allow_cidrs: srcList.length ? srcList : undefined,
  };
  const denyList = parseSourceAllowListInput(($("route-f-source-deny") && $("route-f-source-deny").value) || "");
  if (denyList.length) entry.source_deny_cidrs = denyList;
  const gm = ($("route-f-geo-mode") && $("route-f-geo-mode").value) || "inherit";
  if (gm && gm !== "inherit") {
    entry.geo_mode = gm;
    if (gm === "custom") {
      const gcc = parseSourceAllowListInput(($("route-f-geo-countries") && $("route-f-geo-countries").value) || "");
      if (gcc.length) entry.geo_countries = gcc;
    }
  }
  const maps = readPortMapsFromForm(ports);
  if (maps) entry.port_maps = maps;
  const routeRL = readRateLimitFromForm("route");
  if (routeRL) entry.rate_limit = routeRL;
  else delete entry.rate_limit;
  const idxRaw = $("route-edit-index").value;
  if (idxRaw === "") cfg.forwarding.routes.push(entry);
  else cfg.forwarding.routes[+idxRaw] = entry;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setRoutesMsg("Routes saved. Open Pending changes to review nftables, then Apply to host.");
    closeRouteEditor();
    renderRoutesTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    setRoutesMsg(String(e.message || e), true);
  }
}

async function removeRoute(index) {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.forwarding || !cfg.forwarding.routes) return;
  cfg.forwarding.routes.splice(index, 1);
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setRoutesMsg("Route removed from config. Apply on Pending changes when ready.");
    renderRoutesTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    setRoutesMsg(String(e.message || e), true);
  }
}

export async function refreshRoutesPage() {
  setRoutesMsg("");
  try {
    state.lastConfig = await api("/v1/config");
    setApiStatus(true);
    renderRoutesTable(state.lastConfig);
    peerTunnelIPv4Options(state.lastConfig);
  } catch (e) {
    setApiStatus(false, String(e.message || e));
    setRoutesMsg(String(e.message || e), true);
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initRoutesPage() {
  const routePortMapMode = $("route-f-port-map-mode");
  if (routePortMapMode) routePortMapMode.addEventListener("change", syncRoutePortMapModeUI);
  const routeGeoMode = $("route-f-geo-mode");
  if (routeGeoMode) routeGeoMode.addEventListener("change", syncRouteGeoModeUI);
  const routePortsInput = $("route-f-ports");
  if (routePortsInput) routePortsInput.addEventListener("input", () => renderRoutePortMapRows(readPortMapsFromForm(parsePortsList(routePortsInput.value))));

  $("routes-refresh").addEventListener("click", refreshRoutesPage);

  $("routes-add").addEventListener("click", () => {
    if (!state.lastConfig) refreshRoutesPage().then(() => openRouteEditor(-1));
    else openRouteEditor(-1);
  });
  const routeTabDefault = $("route-tab-default-btn");
  const routeTabAdvanced = $("route-tab-advanced-btn");
  if (routeTabDefault) routeTabDefault.addEventListener("click", () => setRouteEditorTab("default"));
  if (routeTabAdvanced) routeTabAdvanced.addEventListener("click", () => setRouteEditorTab("advanced"));
  $("route-save").addEventListener("click", saveRouteEditor);
  $("route-cancel").addEventListener("click", closeRouteEditor);

  const routeModal = $("route-modal");
  const routeBackdrop = routeModal && routeModal.querySelector(".modal-backdrop");
  if (routeBackdrop) routeBackdrop.addEventListener("click", closeRouteEditor);
  const routeProbeModal = $("route-probe-modal");
  const routeProbeBackdrop = routeProbeModal && routeProbeModal.querySelector(".modal-backdrop");
  if (routeProbeBackdrop) routeProbeBackdrop.addEventListener("click", closeRouteProbeModal);
  const routeProbeRun = $("route-probe-run");
  if (routeProbeRun) {
    routeProbeRun.addEventListener("click", () => {
      if (!state.routeProbePending) return;
      const idx = state.routeProbePending.index;
      const set = state.routeProbePending.portsSet;
      const inp = $("route-probe-port-input");
      const port = Math.floor(+(inp && inp.value));
      if (!Number.isFinite(port) || !set.has(port)) {
        setRoutesMsg("Enter a port that belongs to this route.", true);
        return;
      }
      closeRouteProbeModal();
      void runRouteProbeWithPort(idx, port);
    });
  }
  const routeProbeCancel = $("route-probe-cancel");
  if (routeProbeCancel) routeProbeCancel.addEventListener("click", closeRouteProbeModal);
}
