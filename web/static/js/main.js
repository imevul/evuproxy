import { navigate, onHash } from "./core/router.js";
import { $, applyPeersRoutesTableFilter } from "./core/dom.js";
import { initModals, closeConfirmModal, openModal, closeModal } from "./core/modal.js";
import { initTokenPage } from "./pages/token.js";
import { initSettingsPage } from "./pages/settings.js";
import { initOverviewPage } from "./pages/overview.js";
import { initPeersPage, closePeerEditor } from "./pages/peers.js";
import { initRoutesPage, closeRouteEditor, closeRouteProbeModal } from "./pages/routes.js";
import { initTopologyPage } from "./pages/topology.js";
import { initInboundPage, closeInboundEditor } from "./pages/inbound.js";
import { initGeoblockingPage, closeGeoCountryModal } from "./pages/geoblocking.js";
import { initPendingPage } from "./pages/pending.js";
import { initStatsPage } from "./pages/stats.js";
import { initLogsPage } from "./pages/logs.js";

function closeContextHelpModal() {
  const m = $("context-help-modal");
  if (m) closeModal(m);
  const bd = $("context-help-body");
  if (bd) bd.innerHTML = "";
}

function closeShortcutsModal() {
  const m = $("shortcuts-modal");
  if (m) closeModal(m);
}

/* ——— Init wiring ——— */
function setShellNavOpen(open) {
  const shell = document.body;
  const btn = $("shell-menu-toggle");
  const backdrop = $("sidebar-backdrop");
  if (!shell) return;
  shell.classList.toggle("is-nav-open", !!open);
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  }
  if (backdrop) backdrop.hidden = !open;
}

document.querySelectorAll(".nav-link").forEach((a) => {
  a.addEventListener("click", (ev) => {
    if (a.classList.contains("nav-disabled")) {
      ev.preventDefault();
      return;
    }
    ev.preventDefault();
    setShellNavOpen(false);
    void navigate(a.getAttribute("data-route"));
  });
});
window.addEventListener("hashchange", () => void onHash());

const shellMenuBtn = $("shell-menu-toggle");
if (shellMenuBtn) {
  shellMenuBtn.addEventListener("click", () => {
    setShellNavOpen(!document.body.classList.contains("is-nav-open"));
  });
}
const shellBackdrop = $("sidebar-backdrop");
if (shellBackdrop) {
  shellBackdrop.addEventListener("click", () => setShellNavOpen(false));
}
if (typeof window !== "undefined" && window.matchMedia) {
  const mqWide = window.matchMedia("(min-width: 768px)");
  const onWide = () => {
    if (mqWide.matches) setShellNavOpen(false);
  };
  if (mqWide.addEventListener) mqWide.addEventListener("change", onWide);
  else if (mqWide.addListener) mqWide.addListener(onWide);
}

initTokenPage();
initSettingsPage();

document.body.addEventListener("click", (ev) => {
  const trig = ev.target.closest("button[data-help-template]");
  if (!trig || trig.closest("#context-help-modal")) return;
  const tid = trig.getAttribute("data-help-template");
  if (!tid) return;
  const tmpl = document.getElementById(tid);
  const modal = $("context-help-modal");
  const bd = $("context-help-body");
  const titleEl = $("context-help-modal-title");
  if (!tmpl || !tmpl.content || !modal || !bd || !titleEl) return;
  ev.preventDefault();
  bd.innerHTML = "";
  bd.appendChild(tmpl.content.cloneNode(true));
  const ht = trig.getAttribute("data-help-title");
  titleEl.textContent = ht && String(ht).trim() ? String(ht).trim() : "Help";
  openModal(modal);
});
const ctxHelpClose = $("context-help-close");
if (ctxHelpClose) ctxHelpClose.addEventListener("click", closeContextHelpModal);
const ctxHelpBd = $("context-help-backdrop");
if (ctxHelpBd) ctxHelpBd.addEventListener("click", closeContextHelpModal);

const gSearch = $("global-table-search");
if (gSearch) {
  gSearch.addEventListener("input", () => applyPeersRoutesTableFilter());
}
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    closeShortcutsModal();
    return;
  }
  if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) return;
    ev.preventDefault();
    if (gSearch) gSearch.focus();
    return;
  }
  const helpKey = ev.key === "?" || (ev.shiftKey && ev.key === "/");
  if (helpKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
    const tag = (ev.target && ev.target.tagName) || "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) return;
    ev.preventDefault();
    const sm = $("shortcuts-modal");
    if (sm) openModal(sm);
  }
});

initOverviewPage();
initPeersPage();
initRoutesPage();
initTopologyPage();
initInboundPage();
initGeoblockingPage();
initModals();

const shortcutsClose = $("shortcuts-modal-close");
if (shortcutsClose) shortcutsClose.addEventListener("click", closeShortcutsModal);
const shortcutsBackdrop = document.querySelector("#shortcuts-modal .modal-backdrop");
if (shortcutsBackdrop) shortcutsBackdrop.addEventListener("click", closeShortcutsModal);

document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  const chHelp = $("context-help-modal");
  if (chHelp && !chHelp.classList.contains("is-hidden")) {
    closeContextHelpModal();
    ev.preventDefault();
    return;
  }
  const gm = $("geo-country-modal");
  if (gm && !gm.classList.contains("is-hidden")) {
    closeGeoCountryModal();
    ev.preventDefault();
    return;
  }
  const cm = $("confirm-modal");
  if (cm && !cm.classList.contains("is-hidden")) {
    closeConfirmModal();
    ev.preventDefault();
    return;
  }
  const rpm = $("route-probe-modal");
  if (rpm && !rpm.classList.contains("is-hidden")) {
    closeRouteProbeModal();
    ev.preventDefault();
    return;
  }
  const rm = $("route-modal");
  if (rm && !rm.classList.contains("is-hidden")) {
    closeRouteEditor();
    ev.preventDefault();
    return;
  }
  const im = $("inbound-modal");
  if (im && !im.classList.contains("is-hidden")) {
    closeInboundEditor();
    ev.preventDefault();
    return;
  }
  const pm = $("peer-modal");
  if (pm && !pm.classList.contains("is-hidden")) {
    closePeerEditor();
    ev.preventDefault();
    return;
  }
  if (document.body.classList.contains("is-nav-open")) {
    setShellNavOpen(false);
    ev.preventDefault();
  }
});

initStatsPage();
initLogsPage();
initPendingPage();

void onHash();
