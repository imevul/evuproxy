import { navigate, onHash } from "./core/router.js";
import { $, applyPeersRoutesTableFilter } from "./core/dom.js";
import {
  initModals,
  openModal,
  closeModal,
  closeTopModal,
  registerModalCloser,
} from "./core/modal.js";
import { initTablists } from "./core/tabs.js";
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

const NAV_FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function navDrawer() {
  return document.querySelector(".evu-sidebar");
}

/** Focusable items in the drawer, skipping anything currently hidden. */
function navFocusables() {
  const drawer = navDrawer();
  if (!drawer) return [];
  return Array.from(drawer.querySelectorAll(NAV_FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Keeps Tab inside the drawer while it covers the page.
 *
 * The drawer is an overlay on narrow viewports, so tabbing out of it lands on
 * content the user cannot see. Only bound while the drawer is open.
 */
function onNavTrapKeydown(ev) {
  if (ev.key !== "Tab") return;
  const items = navFocusables();
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const drawer = navDrawer();
  const inside = drawer && drawer.contains(document.activeElement);
  if (ev.shiftKey) {
    if (!inside || document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    }
  } else if (!inside || document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function setShellNavOpen(open) {
  const shell = document.body;
  const btn = $("shell-menu-toggle");
  const backdrop = $("sidebar-backdrop");
  if (!shell) return;
  const wasOpen = shell.classList.contains("is-nav-open");
  shell.classList.toggle("is-nav-open", !!open);
  if (btn) {
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close navigation" : "Open navigation");
  }
  if (backdrop) backdrop.hidden = !open;
  if (open === wasOpen) return;

  if (open) {
    document.addEventListener("keydown", onNavTrapKeydown);
    const items = navFocusables();
    if (items.length) items[0].focus();
  } else {
    document.removeEventListener("keydown", onNavTrapKeydown);
    // Whatever had focus inside the drawer is now hidden, so hand focus back to
    // the control that opened it. Focus elsewhere on the page is left alone.
    const drawer = navDrawer();
    if (btn && drawer && drawer.contains(document.activeElement)) btn.focus();
  }
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
initTablists();

const shortcutsClose = $("shortcuts-modal-close");
if (shortcutsClose) shortcutsClose.addEventListener("click", closeShortcutsModal);
const shortcutsBackdrop = document.querySelector("#shortcuts-modal .modal-backdrop");
if (shortcutsBackdrop) shortcutsBackdrop.addEventListener("click", closeShortcutsModal);

registerModalCloser($("shortcuts-modal"), closeShortcutsModal);
registerModalCloser($("context-help-modal"), closeContextHelpModal);
registerModalCloser($("geo-country-modal"), closeGeoCountryModal);
registerModalCloser($("route-probe-modal"), closeRouteProbeModal);
registerModalCloser($("route-modal"), closeRouteEditor);
registerModalCloser($("inbound-modal"), closeInboundEditor);
registerModalCloser($("peer-modal"), closePeerEditor);

/*
 * Escape closes the dialog that is actually on top. A fixed priority list got
 * this wrong whenever one modal opened over another — the QR code opens from
 * the peer editor, and the list closed the editor underneath it, leaving the QR
 * dialog stranded over an inert page.
 */
document.addEventListener("keydown", (ev) => {
  if (ev.key !== "Escape") return;
  if (closeTopModal()) {
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
