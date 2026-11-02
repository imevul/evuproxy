/*
 * Save confirmations, on the theme's `.evu-toaster` / `.evu-toast` styles.
 *
 * One toast at a time, in the `role="status"` region from index.html. A new toast
 * reuses the element on screen rather than stacking a second one, so a toast that
 * is still entering or already leaving retargets to visible instead of jumping.
 *
 * The timer pauses while the pointer or focus is on the toast and while the tab is
 * hidden: a confirmation that expires unseen has confirmed nothing.
 */

const TOAST_DURATION_MS = 10000;
/** Safety net for removal when no transition runs to fire `transitionend`. */
const LEAVE_FALLBACK_MS = 400;

let toastEl = null;
let messageEl = null;
let actionEl = null;
let closeEl = null;
let sticky = false;
let hovered = false;
let remainingMs = 0;
let timerId = null;
let timerStartedAt = 0;
let leaveFallbackId = null;
/** Where focus came from when it entered the toast, so dismissing can hand it back. */
let returnFocusEl = null;

function timerShouldRun() {
  return !!toastEl && !sticky && !hovered && !document.hidden && !toastEl.contains(document.activeElement);
}

function syncTimer() {
  if (timerShouldRun()) {
    if (timerId !== null) return;
    timerStartedAt = Date.now();
    timerId = window.setTimeout(dismissToast, remainingMs);
  } else if (timerId !== null) {
    window.clearTimeout(timerId);
    timerId = null;
    remainingMs = Math.max(0, remainingMs - (Date.now() - timerStartedAt));
  }
}

function resetTimer() {
  if (timerId !== null) window.clearTimeout(timerId);
  timerId = null;
  remainingMs = TOAST_DURATION_MS;
  syncTimer();
}

function removeToastEl() {
  if (leaveFallbackId !== null) window.clearTimeout(leaveFallbackId);
  leaveFallbackId = null;
  if (toastEl) toastEl.remove();
  toastEl = messageEl = actionEl = closeEl = returnFocusEl = null;
  hovered = false;
}

function createToastEl() {
  toastEl = document.createElement("div");
  toastEl.className = "evu-toast";

  messageEl = document.createElement("span");
  messageEl.className = "evu-toast__message";

  closeEl = document.createElement("button");
  closeEl.type = "button";
  closeEl.className = "evu-toast__close";
  closeEl.setAttribute("aria-label", "Dismiss");
  closeEl.textContent = "×";
  closeEl.addEventListener("click", dismissToast);

  toastEl.append(messageEl, closeEl);
  toastEl.addEventListener("pointerenter", () => {
    hovered = true;
    syncTimer();
  });
  toastEl.addEventListener("pointerleave", () => {
    hovered = false;
    syncTimer();
  });
  toastEl.addEventListener("focusin", (ev) => {
    if (ev.relatedTarget && !toastEl.contains(ev.relatedTarget)) returnFocusEl = ev.relatedTarget;
    syncTimer();
  });
  toastEl.addEventListener("focusout", (ev) => {
    if (!toastEl.contains(ev.relatedTarget)) window.requestAnimationFrame(syncTimer);
  });
  toastEl.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    ev.stopPropagation();
    dismissToast();
  });
  toastEl.addEventListener("transitionend", (ev) => {
    if (ev.target === toastEl && toastEl.hasAttribute("data-leaving")) removeToastEl();
  });
  document.getElementById("toaster").append(toastEl);
}

function setToastAction(action) {
  const hadFocus = !!actionEl && actionEl === document.activeElement;
  if (actionEl) actionEl.remove();
  actionEl = null;
  if (action) {
    actionEl = document.createElement("button");
    actionEl.type = "button";
    actionEl.className = "evu-btn evu-btn--outline evu-btn--sm";
    actionEl.textContent = action.label;
    // Once: the button stays clickable while the toast fades out, so a double-click lands twice.
    actionEl.addEventListener(
      "click",
      () => {
        dismissToast();
        action.onClick();
      },
      { once: true }
    );
    toastEl.insertBefore(actionEl, closeEl);
  }
  // Replacing the button must not drop a keyboard user back to <body>.
  if (hadFocus) (actionEl || closeEl).focus();
}

/**
 * Shows `message`, replacing whatever toast is up.
 *
 * `action` ({ label, onClick }) adds a button. `error` turns the auto-dismiss off.
 * Failed saves do not come here: they stay next to the control that failed, in
 * its row or form. This is for failures that have no such place.
 */
export function showToast(message, { action = null, error = false } = {}) {
  if (toastEl) {
    if (leaveFallbackId !== null) window.clearTimeout(leaveFallbackId);
    leaveFallbackId = null;
    toastEl.removeAttribute("data-leaving");
  } else {
    createToastEl();
  }
  sticky = error;
  toastEl.toggleAttribute("data-error", error);
  messageEl.textContent = message;
  setToastAction(action);
  resetTimer();
}

/** Starts the leave transition. Safe to call with nothing on screen. */
export function dismissToast() {
  if (!toastEl || toastEl.hasAttribute("data-leaving")) return;
  if (timerId !== null) window.clearTimeout(timerId);
  timerId = null;
  if (toastEl.contains(document.activeElement)) {
    const back = returnFocusEl && returnFocusEl.isConnected ? returnFocusEl : document.getElementById("main-content");
    if (back) back.focus();
  }
  toastEl.setAttribute("data-leaving", "");
  leaveFallbackId = window.setTimeout(removeToastEl, LEAVE_FALLBACK_MS);
}

document.addEventListener("visibilitychange", syncTimer);
