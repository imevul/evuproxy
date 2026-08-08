/*
 * Keyboard support for every [role="tablist"] in the shell.
 *
 * The tabs were click-only: each button was its own tab stop, so tabbing
 * through a dialog walked every tab before reaching the panel, and arrow keys
 * did nothing. This applies the ARIA authoring-practices pattern instead — one
 * tab stop per list, arrows/Home/End to move within it — without any page
 * having to opt in.
 *
 * Activation is automatic (moving to a tab selects it). All panels are already
 * in the DOM and switching them is just a hidden toggle, so there is nothing to
 * defer with manual activation.
 */

const TAB = '[role="tab"]';

function tabsIn(tablist) {
  // Not `:scope > `: the pending diff toolbar wraps its tabs in a styling div.
  return Array.from(tablist.querySelectorAll(TAB));
}

function isSelectable(tab) {
  return !tab.disabled && tab.getAttribute("aria-disabled") !== "true";
}

/**
 * Gives the list exactly one tab stop: the selected tab, or the first
 * selectable one when the selection is on a tab the user cannot reach.
 */
function syncTabStops(tablist) {
  const tabs = tabsIn(tablist);
  if (!tabs.length) return;
  const selectable = tabs.filter(isSelectable);
  const selected = tabs.find((t) => t.getAttribute("aria-selected") === "true");
  const stop =
    selected && isSelectable(selected) ? selected : selectable[0] || tabs[0];
  for (const tab of tabs) tab.tabIndex = tab === stop ? 0 : -1;
}

function moveTo(tablist, tab) {
  if (!tab) return;
  tab.focus();
  tab.click();
  syncTabStops(tablist);
}

function onKeydown(ev) {
  const tab = ev.target.closest(TAB);
  if (!tab) return;
  const tablist = tab.closest('[role="tablist"]');
  if (!tablist) return;

  const selectable = tabsIn(tablist).filter(isSelectable);
  const i = selectable.indexOf(tab);
  if (i < 0) return;

  let next = null;
  switch (ev.key) {
    case "ArrowRight":
    case "ArrowDown":
      next = selectable[(i + 1) % selectable.length];
      break;
    case "ArrowLeft":
    case "ArrowUp":
      next = selectable[(i - 1 + selectable.length) % selectable.length];
      break;
    case "Home":
      next = selectable[0];
      break;
    case "End":
      next = selectable[selectable.length - 1];
      break;
    default:
      return;
  }
  ev.preventDefault();
  moveTo(tablist, next);
}

/**
 * One-time wiring for all tablists present in the document.
 *
 * Selection and the Advanced gate are owned by the pages, which flip
 * aria-selected / aria-disabled directly; observing those attributes keeps the
 * tab stop correct without every page calling back in here.
 */
export function initTablists() {
  const tablists = Array.from(document.querySelectorAll('[role="tablist"]'));
  if (!tablists.length) return;

  document.addEventListener("keydown", onKeydown);

  const observer = new MutationObserver((records) => {
    const touched = new Set();
    for (const r of records) {
      const tablist = r.target.closest && r.target.closest('[role="tablist"]');
      if (tablist) touched.add(tablist);
    }
    for (const tablist of touched) syncTabStops(tablist);
  });

  for (const tablist of tablists) {
    syncTabStops(tablist);
    observer.observe(tablist, {
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-selected", "aria-disabled", "disabled"],
    });
  }
}
