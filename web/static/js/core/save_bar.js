import { $ } from "./dom.js";
import { confirmDiscard } from "./modal.js";
import { registerPageForm } from "./dirty.js";

/*
 * The one save control for a page of related settings: it is fixed to the bottom of
 * the viewport and shows only while the page's form is dirty. A page has at most one,
 * covering all its tabs. It also registers the form with the router, so leaving a dirty
 * page warns.
 */

/**
 * @param {string} route The page's route; the bar goes at the end of `#page-<route>`.
 * @param {object} form
 * @param {() => boolean} form.isDirty
 * @param {() => void} form.clear Forget the form's edits: the router is leaving the page.
 * @param {() => Promise<void>} form.save Throws to keep the bar up, showing the message.
 * @param {() => void} form.discard Put the controls back as they were loaded.
 * @param {() => boolean} [form.isSuppressed] Hide the bar without losing the edits,
 *   for a read-only tab where there is nothing on screen to save.
 * @returns {{ sync: () => void }} Call `sync` after changing the form from script.
 */
export function createSaveBar(route, form) {
  const page = $("page-" + route);

  const bar = document.createElement("div");
  bar.className = "save-bar";
  bar.setAttribute("role", "group");
  bar.setAttribute("aria-label", "Unsaved changes");
  bar.hidden = true;

  const text = document.createElement("span");
  text.className = "save-bar__text";
  text.textContent = "Unsaved changes";

  const error = document.createElement("p");
  error.className = "msg err save-bar__error";
  error.setAttribute("role", "alert");
  error.hidden = true;

  const discardBtn = document.createElement("button");
  discardBtn.type = "button";
  discardBtn.className = "evu-btn evu-btn--outline";
  discardBtn.textContent = "Discard";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "evu-btn evu-btn--primary";
  saveBtn.textContent = "Save";

  const actions = document.createElement("div");
  actions.className = "save-bar__actions";
  actions.append(discardBtn, saveBtn);
  bar.append(text, error, actions);
  page.append(bar);

  let saving = false;
  /** The control the operator came from, so a bar that disappears can hand focus back. */
  let returnFocusEl = null;

  function setError(message) {
    error.textContent = message;
    error.hidden = !message;
  }

  function sync() {
    const dirty = form.isDirty();
    if (!dirty) setError("");
    const hide = !dirty || (!!form.isSuppressed && form.isSuppressed());
    if (hide === bar.hidden) return;
    const hadFocus = bar.contains(document.activeElement);
    bar.hidden = hide;
    if (hide && hadFocus) handFocusBack();
  }

  /** A target on a tab that has since been hidden refuses focus, hence the check after. */
  function handFocusBack() {
    if (returnFocusEl && returnFocusEl.isConnected) returnFocusEl.focus();
    if (document.activeElement === document.body) $("main-content").focus({ preventScroll: true });
  }

  bar.addEventListener("focusin", (ev) => {
    const from = ev.relatedTarget;
    // The discard prompt handing focus back to the bar is not where the operator came from.
    if (from && !bar.contains(from) && !from.closest(".modal")) returnFocusEl = from;
  });

  saveBtn.addEventListener("click", async () => {
    if (saving) return;
    // Not `disabled`: that would drop keyboard focus out of the bar mid-save.
    saving = true;
    saveBtn.setAttribute("aria-busy", "true");
    setError("");
    try {
      await form.save();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      saving = false;
      saveBtn.removeAttribute("aria-busy");
      sync();
    }
  });

  discardBtn.addEventListener("click", () => {
    confirmDiscard(() => {
      form.discard();
      sync();
    });
  });

  // Edits and tab switches inside the page bubble here, after their own handlers ran.
  for (const type of ["input", "change", "click"]) {
    page.addEventListener(type, (ev) => {
      if (!bar.contains(ev.target)) sync();
    });
  }

  registerPageForm(route, {
    isDirty: form.isDirty,
    clear() {
      form.clear();
      sync();
    },
  });

  return { sync };
}
