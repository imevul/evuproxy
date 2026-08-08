import { state } from "./state.js";
import { $ } from "./dom.js";

/*
 * Shared modal helpers. All modals in index.html use `.modal` + `.is-hidden`
 * toggling; `openModal` / `closeModal` wrap that and add focus management
 * (accessibility): remember the element that had focus when the modal opened,
 * move focus into the modal (first focusable element, or the panel itself),
 * trap Tab / Shift+Tab inside the modal while it is open, and restore focus
 * to the remembered element when the modal closes.
 */

const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/** Stack of currently open modals ({ modal, previouslyFocused }); last entry is topmost. */
const openModalStack = [];

/*
 * Per-modal teardown. closeModal only hides the element and restores focus;
 * most modals also have to clear page state (a pending confirm callback, help
 * body markup, an editor's draft). Escape has to run that same teardown rather
 * than just hiding the dialog, so each owner registers its closer here.
 */
const modalClosers = new WeakMap();

/** Everything Escape and the backdrop should run to dismiss `modal`. */
export function registerModalCloser(modal, close) {
  if (modal && typeof close === "function") modalClosers.set(modal, close);
}

/**
 * Dismisses the topmost open modal, if any. Returns whether one was closed so
 * callers can decide if the key press was handled.
 */
export function closeTopModal() {
  const top = openModalStack[openModalStack.length - 1];
  if (!top) return false;
  const close = modalClosers.get(top.modal);
  if (close) close();
  else closeModal(top.modal);
  return true;
}

function modalPanel(modal) {
  return modal.querySelector(".modal-panel") || modal;
}

/* ——— Background isolation ——— */

/** Elements this module marked inert, so restoring never clears a pre-existing one. */
let inertedByUs = [];

/**
 * Makes everything outside `modal` inert.
 *
 * The dialogs are not siblings of the shell — they sit inside the page section
 * that owns them — so inerting a single wrapper would also inert the dialog.
 * Instead walk from the modal up to <body> and inert each ancestor's other
 * children, which leaves exactly the modal's own branch interactive.
 */
function applyBackgroundInert(modal) {
  clearBackgroundInert();
  if (!modal || !("inert" in HTMLElement.prototype)) return;
  for (let node = modal; node && node !== document.body; node = node.parentElement) {
    const parent = node.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === node || sibling.inert) continue;
      sibling.inert = true;
      inertedByUs.push(sibling);
    }
  }
}

function clearBackgroundInert() {
  for (const el of inertedByUs) el.inert = false;
  inertedByUs = [];
}

/** Stops the page and the independently scrolling main column from scrolling behind a dialog. */
function setScrollLock(locked) {
  document.body.classList.toggle("is-modal-open", locked);
}

/** Re-applies isolation for whatever is topmost now (or tears it down when nothing is). */
function syncBackground() {
  const top = openModalStack[openModalStack.length - 1];
  if (top) {
    applyBackgroundInert(top.modal);
    setScrollLock(true);
  } else {
    clearBackgroundInert();
    setScrollLock(false);
  }
}

/** Focusable elements inside the modal panel, skipping hidden ones (e.g. inactive tab panels). */
function modalFocusables(modal) {
  const panel = modalPanel(modal);
  return Array.from(panel.querySelectorAll(MODAL_FOCUSABLE_SELECTOR)).filter((el) => {
    if (el.closest("[hidden]")) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden";
  });
}

function focusModalPanel(modal) {
  const panel = modalPanel(modal);
  if (!panel.hasAttribute("tabindex")) panel.setAttribute("tabindex", "-1");
  panel.focus();
}

/** Show a modal and start managing focus for it. */
export function openModal(modal) {
  if (!modal) return;
  const alreadyOpen = openModalStack.some((e) => e.modal === modal);
  modal.classList.remove("is-hidden");
  if (alreadyOpen) return;
  openModalStack.push({ modal, previouslyFocused: document.activeElement });
  syncBackground();
  /* rAF so open paths that focus a specific field afterwards win (they also use rAF, queued later). */
  requestAnimationFrame(() => {
    if (modal.classList.contains("is-hidden")) return;
    const panel = modalPanel(modal);
    if (panel.contains(document.activeElement)) return;
    const focusables = modalFocusables(modal);
    if (focusables.length) focusables[0].focus();
    else focusModalPanel(modal);
  });
}

/** Hide a modal and restore focus to the element focused before it opened. */
export function closeModal(modal) {
  if (!modal) return;
  modal.classList.add("is-hidden");
  const i = openModalStack.findIndex((e) => e.modal === modal);
  if (i < 0) return;
  const wasTopmost = i === openModalStack.length - 1;
  const entry = openModalStack.splice(i, 1)[0];
  syncBackground();
  // Restoring focus is only right for the dialog the user was actually in.
  // Closing one underneath (a page refresh tearing down an editor while its QR
  // code is up) must leave focus where it is.
  if (!wasTopmost) return;
  const prev = entry.previouslyFocused;
  // Runs after syncBackground so the restore target is no longer inert;
  // focusing an inert element silently drops focus to <body>.
  if (prev && typeof prev.focus === "function" && document.contains(prev)) {
    prev.focus();
  }
}

/** Keep Tab / Shift+Tab cycling inside the topmost open modal. */
function onModalTrapKeydown(ev) {
  if (ev.key !== "Tab" || !openModalStack.length) return;
  const { modal } = openModalStack[openModalStack.length - 1];
  if (modal.classList.contains("is-hidden")) return;
  const focusables = modalFocusables(modal);
  if (!focusables.length) {
    ev.preventDefault();
    focusModalPanel(modal);
    return;
  }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement;
  const inside = modalPanel(modal).contains(active);
  if (ev.shiftKey) {
    if (!inside || active === first) {
      ev.preventDefault();
      last.focus();
    }
  } else if (!inside || active === last) {
    ev.preventDefault();
    first.focus();
  }
}

/* ——— Confirm modal (shared across pages) ——— */

export function closeConfirmModal() {
  state.confirmModalCallback = null;
  const m = $("confirm-modal");
  if (m) closeModal(m);
}

export function openConfirmModal(opts) {
  const titleEl = $("confirm-modal-title");
  const descEl = $("confirm-modal-desc");
  const okBtn = $("confirm-modal-ok");
  const modal = $("confirm-modal");
  if (!titleEl || !descEl || !okBtn || !modal) return;
  titleEl.textContent = opts.title || "Confirm";
  descEl.textContent = opts.message || "";
  okBtn.textContent = opts.confirmLabel || "OK";
  state.confirmModalCallback = opts.onConfirm || null;
  openModal(modal);
  const cancelBtn = $("confirm-modal-cancel");
  if (cancelBtn) requestAnimationFrame(() => cancelBtn.focus());
}

/** One-time wiring: confirm modal buttons + the global modal focus trap. */
export function initModals() {
  document.addEventListener("keydown", onModalTrapKeydown);
  registerModalCloser($("confirm-modal"), closeConfirmModal);
  const confirmModal = $("confirm-modal");
  const confirmBackdrop = confirmModal && confirmModal.querySelector(".modal-backdrop");
  if (confirmBackdrop) confirmBackdrop.addEventListener("click", closeConfirmModal);
  $("confirm-modal-cancel").addEventListener("click", closeConfirmModal);
  $("confirm-modal-ok").addEventListener("click", async () => {
    const fn = state.confirmModalCallback;
    closeConfirmModal();
    if (fn) await fn();
  });
}
