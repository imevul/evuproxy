import { state } from "../core/state.js";
import {
  $,
  escapeHtml,
  setApiStatus,
  tableDisabledToggleCell,
  setEditorMsg,
  setRowError,
  clearRowError,
  rowErrorHtml,
  restoreRowSwitchFocus,
  focusTableRow,
  rowIndexAfterRemoval,
  fadeOutRow,
} from "../core/dom.js";
import { beginLoading } from "../core/loading.js";
import { api } from "../core/api.js";
import { showToast } from "../core/toast.js";
import { sortedRows, sortHeaderHtml, bindSortHeaders, setTableHtml } from "../core/table_sort.js";
import { saveConfigEdit, findConfigRow, resolveListIndex, ConfigMergeError } from "../core/config_save.js";
import { showUndoToast } from "../core/undo.js";
import { openModal, closeModal, dismissModal, registerModalForm } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

/** JSON of the rule open in the editor, to detect it changing elsewhere before Save. */
let inboundEditBase = null;

async function patchInboundDisabled(index, disabled) {
  const cur = state.lastConfig;
  if (!cur || !cur.input_allows || cur.input_allows[index] === undefined) return;
  const identity = inboundRuleIdentity(cur.input_allows[index]);
  // A save can adopt fresh config even when it fails, so the row may have moved or gone.
  const currentIndex = () => resolveListIndex(state.lastConfig.input_allows, index, identity, inboundRuleIdentity);
  try {
    const cfg = await saveConfigEdit((c) => {
      const i = findConfigRow(c.input_allows, index, identity, inboundRuleIdentity, "inbound rule");
      c.input_allows[i].disabled = disabled;
    });
    setInboundMsg("");
    setApiStatus(true);
    refreshPendingBadge();
    renderInboundTable(cfg);
    const label = (off) => (off ? "Inbound rule disabled" : "Inbound rule enabled");
    showUndoToast(label(disabled), {
      page: "inbound",
      edit: (c) => {
        c.input_allows[findConfigRow(c.input_allows, index, identity, inboundRuleIdentity, "inbound rule")].disabled = !disabled;
      },
      afterSave: (next, focus) => {
        setInboundMsg("");
        refreshPendingBadge();
        renderInboundTable(next);
        if (focus) restoreRowSwitchFocus($("inbound-table-wrap"), "data-inbound-disabled", currentIndex(), { force: true });
      },
      message: () => label(!disabled),
    });
  } catch (e) {
    const at = e instanceof ConfigMergeError ? -1 : currentIndex();
    setInboundMsg("");
    if (at >= 0) setRowError("data-inbound-disabled", at, String(e.message || e));
    else setInboundMsg(String(e.message || e), true);
    renderInboundTable(state.lastConfig);
  }
  const focusAt = currentIndex();
  restoreRowSwitchFocus($("inbound-table-wrap"), "data-inbound-disabled", focusAt >= 0 ? focusAt : index);
}

/* ——— Inbound access (input_allows) ——— */
function setInboundMsg(text, isErr) {
  const el = $("inbound-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
  if (!text) clearRowError("data-inbound-disabled");
}

/** The API stores several ports as an nft set, `{ 80, 443 }`. Operators read `80, 443`. */
function dportDisplay(dport) {
  return String(dport || "").replace(/[{}]/g, "").trim();
}

function renderInboundTable(cfg) {
  const wrap = $("inbound-table-wrap");
  if (!wrap) return;
  const rules = cfg.input_allows || [];

  if (!rules.length) {
    wrap.innerHTML =
      "<div class=\"evu-empty\"><p class=\"evu-empty__title\">No inbound rules yet</p><p>Add a rule to open a port on the host itself, outside the tunnel.</p><button type=\"button\" class=\"evu-btn evu-btn--primary\" id=\"inbound-empty-add\">Add rule</button></div>";
    const addBtn = wrap.querySelector("#inbound-empty-add");
    if (addBtn) addBtn.addEventListener("click", () => openInboundEditor(-1));
    return;
  }
  const rows = sortedRows("inbound", rules, {
    proto: (r) => String(r.proto || "").toLowerCase(),
    ports: (r) => dportDisplay(r.dport),
    note: (r) => r.note,
    enabled: (r) => (r.disabled ? 0 : 1),
  })
    .map(({ item: r, index: i }) => {
      const aria =
        "Enabled: INPUT " +
        String(r.proto || "").toLowerCase() +
        " " +
        (dportDisplay(r.dport) || r.note || "#" + i);
      return (
        `<tr data-row="${i}" tabindex="-1"${r.disabled ? ' class="is-row-disabled"' : ""}><td class="mono">${escapeHtml(String(r.proto || "").toLowerCase())}</td><td class="mono">${escapeHtml(dportDisplay(r.dport))}</td><td>${escapeHtml(r.note || "—")}</td>${tableDisabledToggleCell("data-inbound-disabled", i, !!r.disabled, aria)}<td class="row-actions"><button type="button" class="evu-btn evu-btn--outline evu-btn--sm" data-inbound-edit="${i}">Edit</button> <button type="button" class="evu-btn evu-btn--outline evu-btn--sm" data-inbound-del="${i}">Remove</button></td></tr>` +
        rowErrorHtml("data-inbound-disabled", i, 5)
      );
    })
    .join("");
  setTableHtml(
    wrap,
    `<table class="data"><thead><tr>${sortHeaderHtml("inbound", "proto", "Proto")}${sortHeaderHtml("inbound", "ports", "Port(s)")}${sortHeaderHtml("inbound", "note", "Note")}${sortHeaderHtml("inbound", "enabled", "Enabled")}<th scope=\"col\"><span class=\"evu-sr-only\">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`
  );
  bindSortHeaders(wrap, "inbound", () => renderInboundTable(cfg));
  wrap.querySelectorAll("[data-inbound-edit]").forEach((b) => {
    b.addEventListener("click", () => openInboundEditor(+b.getAttribute("data-inbound-edit")));
  });
  wrap.querySelectorAll("[data-inbound-del]").forEach((b) => {
    b.addEventListener("click", (ev) => {
      // The next row slides under the pointer, so a double-click must not remove it too.
      if (ev.detail <= 1) removeInboundRule(+b.getAttribute("data-inbound-del"));
    });
  });
  wrap.querySelectorAll("input[data-inbound-disabled]").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("change", async () => {
      const idx = +inp.getAttribute("data-inbound-disabled");
      const wantEnabled = inp.checked;
      clearRowError("data-inbound-disabled");
      if (wantEnabled) {
        const r = (state.lastConfig.input_allows || [])[idx];
        if (!r || !String(r.dport || "").trim()) {
          setRowError("data-inbound-disabled", idx, "Add a destination port in Edit before enabling this rule.");
          renderInboundTable(state.lastConfig);
          restoreRowSwitchFocus(wrap, "data-inbound-disabled", idx);
          return;
        }
      }
      await patchInboundDisabled(idx, !wantEnabled);
    });
  });
}

function openInboundEditor(index) {
  const cfg = state.lastConfig;
  if (!cfg) return;
  if (!cfg.input_allows) cfg.input_allows = [];
  setEditorMsg("inbound-editor-msg", "");
  const protoSel = $("inbound-f-proto");
  const dport = $("inbound-f-dport");
  const note = $("inbound-f-note");
  if (!protoSel || !dport || !note) return;

  const disInp = $("inbound-f-disabled");
  if (index === -1) {
    $("inbound-edit-index").value = "";
    $("inbound-editor-title").textContent = "Add rule";
    protoSel.value = "tcp";
    dport.value = "";
    note.value = "";
    if (disInp) disInp.checked = true;
  } else {
    const r = cfg.input_allows[index];
    if (!r) return;
    inboundEditBase = JSON.stringify(r);
    $("inbound-edit-index").value = String(index);
    $("inbound-editor-title").textContent = "Edit rule";
    const p = String(r.proto || "tcp").toLowerCase();
    protoSel.value = p === "udp" ? "udp" : "tcp";
    dport.value = r.dport || "";
    note.value = r.note || "";
    if (disInp) disInp.checked = !r.disabled;
  }
  const modal = $("inbound-modal");
  if (modal) {
    openModal(modal);
    requestAnimationFrame(() => dport.focus());
  }
}

export function closeInboundEditor() {
  const modal = $("inbound-modal");
  if (modal) closeModal(modal);
}

async function saveInboundEditor() {
  const proto = ($("inbound-f-proto").value || "tcp").toLowerCase();
  const dport = $("inbound-f-dport").value.trim();
  const note = $("inbound-f-note").value.trim();
  if (proto !== "tcp" && proto !== "udp") {
    setEditorMsg("inbound-editor-msg", "Protocol must be tcp or udp.", $("inbound-f-proto"));
    return;
  }
  const disEl = $("inbound-f-disabled");
  const enabled = disEl && disEl.checked;
  if (enabled && !dport) {
    setEditorMsg("inbound-editor-msg", "Destination port is required.", $("inbound-f-dport"));
    return;
  }
  const entry = { proto };
  if (dport) entry.dport = dport;
  if (note) entry.note = note;
  entry.disabled = !enabled;
  const idxRaw = $("inbound-edit-index").value;
  setEditorMsg("inbound-editor-msg", "");
  const base = inboundEditBase;
  try {
    const cfg = await saveConfigEdit((c) => {
      if (!c.input_allows) c.input_allows = [];
      if (idxRaw === "") c.input_allows.push(entry);
      // The form replaces the whole row, so only a row still as it was when opened is safe to overwrite.
      else c.input_allows[findConfigRow(c.input_allows, +idxRaw, base, JSON.stringify, "inbound rule")] = entry;
    });
    setInboundMsg("");
    closeInboundEditor();
    renderInboundTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
    showToast((idxRaw === "" ? "Inbound rule added." : "Inbound rule saved.") + " Review it on Pending changes, then Apply to host.");
  } catch (e) {
    if (e instanceof ConfigMergeError) {
      setEditorMsg(
        "inbound-editor-msg",
        e.message + " Your values are still in this form: note them, press Cancel, and edit the latest version."
      );
      renderInboundTable(state.lastConfig);
    } else {
      setEditorMsg("inbound-editor-msg", String(e.message || e));
    }
  }
}

function inboundRuleIdentity(r) {
  return (
    String(r.proto || "").toLowerCase() +
    "\0" +
    String(r.dport || "") +
    "\0" +
    String(r.note || "").trim()
  );
}

/** One removal at a time: a second click on the same row would fail as "removed elsewhere". */
let inboundRemoveBusy = false;

async function removeInboundRule(index) {
  const cfg = state.lastConfig;
  if (inboundRemoveBusy || !cfg || !cfg.input_allows || cfg.input_allows[index] === undefined) return;
  const identity = inboundRuleIdentity(cfg.input_allows[index]);
  const wrap = $("inbound-table-wrap");
  const removeBtn = wrap.querySelector(`[data-inbound-del="${index}"]`);
  const row = removeBtn && removeBtn.closest("tr");
  inboundRemoveBusy = true;
  try {
    let removed = null;
    let removedAt = index;
    const c = await saveConfigEdit((draft) => {
      removedAt = findConfigRow(draft.input_allows, index, identity, inboundRuleIdentity, "inbound rule");
      [removed] = draft.input_allows.splice(removedAt, 1);
    });
    const focusAt = rowIndexAfterRemoval(wrap, row, removedAt);
    await fadeOutRow(row);
    setInboundMsg("");
    renderInboundTable(c);
    setApiStatus(true);
    refreshPendingBadge();
    focusTableRow(wrap, focusAt, $("inbound-add"));
    const proto = String(removed.proto || "").toLowerCase() || "—";
    const note = String(removed.note || "").trim();
    const label = proto + " " + (dportDisplay(removed.dport) || "—") + (note ? " (" + note + ")" : "");
    const removedJson = JSON.stringify(removed);
    let restoredAt = removedAt;
    showUndoToast("Removed inbound rule " + label + ".", {
      page: "inbound",
      edit: (draft) => {
        if (!draft.input_allows) draft.input_allows = [];
        // Already back (saved elsewhere since): nothing to reverse. Only the whole row counts,
        // since identity also matches a disabled twin.
        restoredAt = draft.input_allows.findIndex((r) => JSON.stringify(r) === removedJson);
        if (restoredAt !== -1) return false;
        restoredAt = Math.min(removedAt, draft.input_allows.length);
        draft.input_allows.splice(restoredAt, 0, removed);
      },
      afterSave: (next, focus) => {
        setInboundMsg("");
        refreshPendingBadge();
        renderInboundTable(next);
        if (focus) focusTableRow(wrap, restoredAt, $("inbound-add"), { force: true });
      },
      message: () => "Restored inbound rule " + label + ".",
    });
  } catch (e) {
    setInboundMsg(String(e.message || e), true);
    renderInboundTable(state.lastConfig);
  } finally {
    inboundRemoveBusy = false;
  }
}

export async function refreshInboundPage() {
  setInboundMsg("");
  const doneLoading = beginLoading("inbound-table-wrap");
  try {
    state.lastConfig = await api("/v1/config");
    setApiStatus(true);
    renderInboundTable(state.lastConfig);
  } catch (e) {
    setApiStatus(false, String(e.message || e));
    setInboundMsg(String(e.message || e), true);
  } finally {
    doneLoading();
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initInboundPage() {
  $("inbound-refresh").addEventListener("click", refreshInboundPage);
  $("inbound-add").addEventListener("click", () => {
    if (!state.lastConfig) refreshInboundPage().then(() => openInboundEditor(-1));
    else openInboundEditor(-1);
  });
  $("inbound-save").addEventListener("click", saveInboundEditor);

  const inboundModal = $("inbound-modal");
  registerModalForm(inboundModal);
  $("inbound-cancel").addEventListener("click", () => dismissModal(inboundModal));
  const inboundBackdrop = inboundModal && inboundModal.querySelector(".modal-backdrop");
  if (inboundBackdrop) inboundBackdrop.addEventListener("click", () => dismissModal(inboundModal));
}
