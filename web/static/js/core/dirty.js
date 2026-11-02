import { $ } from "./dom.js";

/*
 * Unsaved-edit tracking shared by dialogs and page forms. A tracker remembers
 * what the form's controls held when it was loaded, and is dirty while they
 * differ, so typing a change and undoing it reads as clean again.
 */

function readControls(controls) {
  const values = {};
  Array.from(controls).forEach((el, i) => {
    if (el.type === "hidden" || el.type === "file") return;
    const isToggle = el.type === "checkbox" || el.type === "radio";
    values[el.id || "#" + i] = isToggle ? el.checked : el.value;
  });
  return values;
}

/**
 * @param {() => Iterable<Element>} getControls The form's inputs, selects and textareas.
 * @returns A tracker that stays clean until `mark` has set its baseline.
 */
export function createFormTracker(getControls) {
  let baseline = null;
  return {
    /**
     * Treats the current values as saved. Pass `ids` to update only those
     * controls, so a late programmatic fill does not also absorb what the
     * operator typed elsewhere in the meantime.
     */
    mark(ids) {
      const now = readControls(getControls());
      if (!ids || !baseline) {
        baseline = now;
        return;
      }
      for (const id of ids) baseline[id] = now[id];
    },
    clear() {
      baseline = null;
    },
    /** Pass `ids` to ask about only those controls. */
    isDirty(ids) {
      if (!baseline) return false;
      const now = readControls(getControls());
      if (ids) return ids.some((id) => now[id] !== baseline[id]);
      return JSON.stringify(now) !== JSON.stringify(baseline);
    },
    /** Puts the controls back to the values `mark` remembered. */
    revert() {
      if (!baseline) return;
      Array.from(getControls()).forEach((el) => {
        if (!el.id || !(el.id in baseline)) return;
        if (el.type === "checkbox" || el.type === "radio") el.checked = baseline[el.id];
        else el.value = baseline[el.id];
      });
    },
  };
}

/** Tracker over a fixed set of controls, for page forms. */
export function createFormTrackerByIds(ids) {
  return createFormTracker(() => ids.map((id) => $(id)).filter(Boolean));
}

/** Route name → { isDirty, clear } for the form that route's page holds. */
const pageForms = new Map();

/** Declares the form the router must guard while `route` is the current page. */
export function registerPageForm(route, form) {
  pageForms.set(route, form);
}

export function pageForm(route) {
  return pageForms.get(route) || null;
}
