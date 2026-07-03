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

function modalPanel(modal) {
  return modal.querySelector(".modal-panel") || modal;
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
  const entry = openModalStack.splice(i, 1)[0];
  const prev = entry.previouslyFocused;
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
