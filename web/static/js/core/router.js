import { state } from "./state.js";
import { $ } from "./dom.js";
import { ensureApiGate, applyNavRestriction } from "./api.js";
import { ensureUIPrefs } from "./prefs.js";
import { closeConfirmModal } from "./modal.js";
import { refreshSidebarAbout } from "./sidebar.js";
import {
  refreshOverviewPage,
  restartOverviewEventsPolling,
  restartOverviewLatencyPolling,
  stopOverviewEventsPolling,
  stopOverviewLatencyPolling,
} from "../pages/overview.js";
import { refreshSettingsPage, setSettingsEditorTab } from "../pages/settings.js";
import { refreshTokenPage } from "../pages/token.js";
import { refreshPeersPage, stopPeersPingPolling, closePeerEditor } from "../pages/peers.js";
import { refreshRoutesPage, closeRouteEditor, closeRouteProbeModal } from "../pages/routes.js";
import { refreshTopologyPage, stopTopologyPolling } from "../pages/topology.js";
import { refreshInboundPage, closeInboundEditor } from "../pages/inbound.js";
import { refreshGeoblockingPage } from "../pages/geoblocking.js";
import { refreshPendingPage, refreshPendingBadge } from "../pages/pending.js";
import { refreshStatsPage } from "../pages/stats.js";
import { refreshLogsPage } from "../pages/logs.js";

const pages = [
  "overview",
  "settings",
  "token",
  "peers",
  "routes",
  "topology",
  "inbound",
  "geoblocking",
  "pending",
  "stats",
  "logs",
];

export async function navigate(name) {
  if (!pages.includes(name)) name = "overview";
  state.hashNavParams = parseHashNavParams();
  closeConfirmModal();
  if (name !== "routes") {
    closeRouteProbeModal();
    closeRouteEditor();
  }
  if (name !== "inbound") closeInboundEditor();
  if (name !== "peers") {
    stopPeersPingPolling();
    closePeerEditor();
  }
  if (name !== "topology") {
    stopTopologyPolling();
  }
  if (name !== "overview" && name !== "token") {
    const ok = await ensureApiGate();
    if (!ok) name = "overview";
  }
  applyNavRestriction();
  await ensureUIPrefs();
  document.querySelectorAll(".page").forEach((p) => {
    p.hidden = true;
  });
  const sec = $("page-" + name);
  if (sec) sec.hidden = false;
  const contentEl = document.querySelector("main.content");
  if (contentEl) contentEl.scrollTop = 0;
  document.querySelectorAll(".nav-link").forEach((a) => {
    const on = a.getAttribute("data-route") === name;
    a.classList.toggle("is-active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  const hraw = (location.hash || "").replace(/^#/, "");
  const hqi = hraw.indexOf("?");
  const curPath = (hqi >= 0 ? hraw.slice(0, hqi) : hraw).replace(/^\//, "").split("/")[0] || "overview";
  if (curPath !== name) {
    location.hash = "#/" + name;
  }
  if (name === "overview") {
    await refreshOverviewPage();
    restartOverviewEventsPolling();
    restartOverviewLatencyPolling();
  } else {
    stopOverviewEventsPolling();
    stopOverviewLatencyPolling();
  }
  if (name === "settings") {
    await refreshSettingsPage();
    setSettingsEditorTab("prefs");
  }
  if (name === "token") {
    refreshTokenPage();
    await ensureApiGate();
  }
  if (name === "peers") {
    await refreshPeersPage();
    applyHashPeerRouteHighlight();
  }
  if (name === "routes") {
    await refreshRoutesPage();
    applyHashPeerRouteHighlight();
  }
  if (name === "topology") {
    state.topologyPrevPeerBytes = new Map();
    void refreshTopologyPage();
    state.topologyPollTimer = setInterval(() => {
      void refreshTopologyPage();
    }, 4000);
  }
  if (name === "inbound") refreshInboundPage();
  if (name === "geoblocking") await refreshGeoblockingPage({ resetTab: true });
  if (name === "pending") refreshPendingPage();
  if (name === "stats") refreshStatsPage();
  if (name === "logs") refreshLogsPage();
  refreshPendingBadge();
  void refreshSidebarAbout();
}

function applyHashPeerRouteHighlight() {
  document.querySelectorAll("#peers-table-wrap tr.row-highlight, #routes-table-wrap tr.row-highlight").forEach((tr) => {
    tr.classList.remove("row-highlight");
  });
  const pi = state.hashNavParams.get("peer");
  if (pi !== null && $("page-peers") && !$("page-peers").hidden) {
    const idx = parseInt(pi, 10);
    if (!isNaN(idx)) {
      const btn = document.querySelector("#peers-table-wrap [data-peer-edit=\"" + idx + "\"]");
      const tr = btn && btn.closest("tr");
      if (tr) {
        tr.classList.add("row-highlight");
        tr.scrollIntoView({ block: "nearest" });
      }
    }
  }
  const ri = state.hashNavParams.get("route");
  if (ri !== null && $("page-routes") && !$("page-routes").hidden) {
    const idx = parseInt(ri, 10);
    if (!isNaN(idx)) {
      const btn = document.querySelector("#routes-table-wrap [data-route-edit=\"" + idx + "\"]");
      const tr = btn && btn.closest("tr");
      if (tr) {
        tr.classList.add("row-highlight");
        tr.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

export async function onHash() {
  const raw = (location.hash || "#/overview").replace(/^#/, "");
  const qi = raw.indexOf("?");
  const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
  state.hashNavParams = qi >= 0 ? new URLSearchParams(raw.slice(qi + 1)) : new URLSearchParams();
  const name = pathPart.replace(/^\//, "").split("/")[0] || "overview";
  await navigate(name || "overview");
}

function parseHashNavParams() {
  const raw = (location.hash || "").replace(/^#/, "");
  const qi = raw.indexOf("?");
  if (qi < 0) return new URLSearchParams();
  return new URLSearchParams(raw.slice(qi + 1));
}
