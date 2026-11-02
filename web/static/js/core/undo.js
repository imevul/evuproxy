/*
 * The Undo offered after a draft edit.
 *
 * The edit is already saved when the toast appears, so closing the tab loses nothing.
 * Undo is a second edit applied to fresh config, never a snapshot of the old one: a
 * snapshot would also wipe whatever was saved in between.
 *
 * The toast is a shortcut and expires. Per-item Revert on Pending changes is the
 * path with no time limit.
 */
import { state } from "./state.js";
import { setApiStatus } from "./dom.js";
import { showToast } from "./toast.js";
import { saveConfigEdit, ConfigMergeError } from "./config_save.js";

/** Re-renders whichever page is on screen; set by the router, which imports the pages. */
let refreshVisiblePage = () => {};

export function setUndoPageRefresh(fn) {
  refreshVisiblePage = fn;
}

function isPageOnScreen(page) {
  const el = document.getElementById("page-" + page);
  return !!el && !el.hidden;
}

async function runUndo(undo) {
  const onPage = isPageOnScreen(undo.page);
  try {
    const cfg = await saveConfigEdit(undo.edit);
    setApiStatus(true);
    undo.afterSave(cfg, onPage);
    showToast(undo.message());
    // Undo outlives navigation, and it can change what the page now on screen shows.
    if (!onPage) refreshVisiblePage();
  } catch (e) {
    undo.afterSave(state.lastConfig, false);
    // A merge failure will not go away on retry; anything else (network, 503) might.
    const retry = e instanceof ConfigMergeError ? null : { label: "Undo", onClick: () => runUndo(undo) };
    showToast("Could not undo: " + String(e.message || e), { error: true, action: retry });
  }
}

/**
 * Confirms a saved edit with an Undo button.
 *
 * `undo.page` is the route the edit was made on. `undo.edit(draft)` reverses it, under
 * the same rules as saveConfigEdit. `undo.afterSave(cfg, focus)` re-renders, moving focus
 * back to the row if `focus` is set; it also runs after a failure, since the save may
 * have adopted fresh config. `undo.message()` is the confirmation, read after the save
 * so it can report what the edit found.
 */
export function showUndoToast(message, undo) {
  showToast(message, { action: { label: "Undo", onClick: () => runUndo(undo) } });
}
