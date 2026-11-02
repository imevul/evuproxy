import { state } from "./state.js";
import { $, setApiNotConnected, setApiStatus } from "./dom.js";
import { ensureApiGate, applyNavRestriction, token } from "./api.js";
import { setGeoEditorTab } from "./advanced.js";
import { beginLoading } from "./loading.js";
import { setTitlePage } from "./title.js";
import { ensureUIPrefs } from "./prefs.js";
import { anyOpenModalDirty, closeAllModals, closeConfirmModal, confirmDiscard } from "./modal.js";
import { pageForm } from "./dirty.js";
import { refreshSidebarAbout } from "./sidebar.js";
import { setUndoPageRefresh } from "./undo.js";
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

/* What each page refreshes, so it reads as busy from the click, before its own load starts. */
const pageLoadRegions = {
  overview: ["overview-cards"],
  settings: ["settings-tab-prefs-panel", "settings-tab-maint-panel"],
  peers: ["peers-table-wrap"],
  routes: ["routes-table-wrap"],
  topology: ["topology-graph-wrap"],
  inbound: ["inbound-table-wrap"],
  geoblocking: ["geo-tab-default-panel", "geo-tab-advanced-panel"],
  pending: ["pending-diff-panel"],
  stats: ["stats-wg-wrap", "stats-nft-wrap"],
  logs: ["logs-view"],
};

/* Bumped by every navigate() past the guard, so a slower earlier one stops once it wakes up. */
let navSeq = 0;
/** The page on screen, once a navigation has got past the unsaved-edits guard. */
let currentRoute = null;
/** The hash of `currentRoute`, to put back when the operator stays on the page. */
let committedHash = "";
/** A hash `navigate` set itself: its hashchange must not navigate a second time. */
let selfSetHash = null;

/**
 * Whether going to `target` would lose edits. With no target (the tab closing),
 * every open dialog counts. Coming back to the current route keeps its dialogs
 * open but reloads its page form, so only the form counts then.
 */
export function hasUnsavedEdits(target) {
  const form = pageForm(currentRoute);
  if (form && form.isDirty()) return true;
  return target !== currentRoute && anyOpenModalDirty();
}

function restoreCommittedHash() {
  if (location.hash === committedHash) return;
  // replaceState fires no hashchange, so this cannot re-enter navigate.
  history.replaceState(null, "", location.pathname + location.search + committedHash);
}

function discardEditsFor(target) {
  const form = pageForm(currentRoute);
  if (form) form.clear();
  if (target !== currentRoute) closeAllModals();
}

function showPage(name) {
  document.querySelectorAll(".page").forEach((p) => {
    p.hidden = true;
  });
  const sec = $("page-" + name);
  if (sec) sec.hidden = false;
  setTitlePage(name);
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
    selfSetHash = "#/" + name;
    location.hash = selfSetHash;
  }
  state.hashNavParams = parseHashNavParams();
  committedHash = location.hash;
}

setUndoPageRefresh(() => {
  // Reloading would lose an open form's edits; that form's own save handles the conflict.
  if (currentRoute && !hasUnsavedEdits(currentRoute)) void navigate(currentRoute);
});

/** @param {{ discard?: boolean }} [opts] `discard` once the operator has agreed to lose edits. */
export async function navigate(name, opts) {
  if (!pages.includes(name)) name = "overview";
  if (!(opts && opts.discard) && hasUnsavedEdits(name)) {
    const target = name;
    confirmDiscard(() => {
      discardEditsFor(target);
      return navigate(target, { discard: true });
    }, restoreCommittedHash);
    return;
  }
  const seq = ++navSeq;
  // No token means the gate cannot pass and needs no request to say so. Every
  // page would be a dead end, so the one page that can fix it comes first.
  if (name !== "token" && !token().trim()) name = "token";
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
  stopTopologyPolling();
  if (name !== currentRoute) {
    // The form stays filled in while hidden, so it must not read as dirty until
    // the page has reloaded it on the next visit.
    const leaving = pageForm(currentRoute);
    if (leaving) leaving.clear();
    currentRoute = name;
  }
  if (name !== "overview") {
    stopOverviewEventsPolling();
    stopOverviewLatencyPolling();
  }
  // Everything up to the first await runs on the click; the network comes after.
  showPage(name);
  if (name === "settings") setSettingsEditorTab("prefs");
  if (name === "geoblocking") setGeoEditorTab("default");
  const doneLoading = beginLoading(...(pageLoadRegions[name] || []));
  try {
    if (name !== "overview" && name !== "token") {
      const ok = await ensureApiGate();
      if (seq !== navSeq) return;
      if (!ok) {
        void navigate("overview", { discard: true });
        return;
      }
    }
    applyNavRestriction();
    await ensureUIPrefs();
    if (seq !== navSeq) return;
    if (name === "overview") {
      await refreshOverviewPage();
      if (seq !== navSeq) return;
      restartOverviewEventsPolling();
      restartOverviewLatencyPolling();
    }
    if (name === "settings") await refreshSettingsPage();
    if (name === "token") {
      refreshTokenPage();
      const connected = await ensureApiGate();
      if (seq !== navSeq) return;
      if (token().trim()) setApiStatus(connected);
      else setApiNotConnected();
    }
    if (name === "peers") {
      await refreshPeersPage();
      if (seq === navSeq) applyHashPeerRouteHighlight();
    }
    if (name === "routes") {
      await refreshRoutesPage();
      if (seq === navSeq) applyHashPeerRouteHighlight();
    }
    if (name === "topology") {
      state.topologyPrevPeerBytes = new Map();
      void refreshTopologyPage();
      state.topologyPollTimer = setInterval(() => {
        void refreshTopologyPage({ background: true });
      }, 4000);
    }
    if (name === "inbound") refreshInboundPage();
    if (name === "geoblocking") await refreshGeoblockingPage();
    if (name === "pending") refreshPendingPage();
    if (name === "stats") refreshStatsPage();
    if (name === "logs") refreshLogsPage();
    if (seq !== navSeq) return;
    refreshPendingBadge();
    void refreshSidebarAbout();
  } finally {
    doneLoading();
  }
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
  const isOwnHash = selfSetHash !== null && location.hash === selfSetHash;
  selfSetHash = null;
  // This page is already loading. A second load could land after the operator
  // starts typing and overwrite their edits.
  if (isOwnHash) return;
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
