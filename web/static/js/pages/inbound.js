import { state } from "../core/state.js";
import {
  $,
  escapeHtml,
  setApiStatus,
  tableDisabledToggleCell,
  markFieldInvalid,
  clearFieldInvalid,
} from "../core/dom.js";
import { api } from "../core/api.js";
import { saveConfigEdit, findConfigRow, ConfigMergeError } from "../core/config_save.js";
import { openModal, closeModal, openConfirmModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

/** JSON of the rule open in the editor, to detect it changing elsewhere before Save. */
let inboundEditBase = null;

async function patchInboundDisabled(index, disabled) {
  const cur = state.lastConfig;
  if (!cur || !cur.input_allows || cur.input_allows[index] === undefined) return;
  const identity = inboundRuleIdentity(cur.input_allows[index]);
  try {
    const cfg = await saveConfigEdit((c) => {
      const i = findConfigRow(c.input_allows, index, identity, inboundRuleIdentity, "inbound rule");
      c.input_allows[i].disabled = disabled;
    });
    setInboundMsg("");
    setApiStatus(true);
    refreshPendingBadge();
    renderInboundTable(cfg);
  } catch (e) {
    setInboundMsg(String(e.message || e), true);
    renderInboundTable(state.lastConfig);
  }
}

/* ——— Inbound access (input_allows) ——— */
function setInboundMsg(text, isErr, field) {
  const el = $("inbound-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
  if (isErr && field) markFieldInvalid(el, field);
  else clearFieldInvalid(el);
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
  const rows = rules
    .map((r, i) => {
      const aria =
        "Enabled: INPUT " +
        String(r.proto || "").toLowerCase() +
        " " +
        String(r.dport || r.note || "#" + i);
      return (
        `<tr><td class="mono">${escapeHtml(String(r.proto || "").toLowerCase())}</td><td class="mono">${escapeHtml(r.dport || "")}</td><td>${escapeHtml(r.note || "—")}</td>${tableDisabledToggleCell("data-inbound-disabled", i, !!r.disabled, aria)}<td class="row-actions"><button type="button" class="evu-btn evu-btn--outline evu-btn--sm" data-inbound-edit="${i}">Edit</button> <button type="button" class="evu-btn evu-btn--outline evu-btn--sm" data-inbound-del="${i}">Remove</button></td></tr>`
      );
    })
    .join("");
  wrap.innerHTML = `<table class="data"><thead><tr><th scope="col">Proto</th><th scope="col">Port(s)</th><th scope="col">Note</th><th scope="col">Enabled</th><th scope=\"col\"><span class=\"evu-sr-only\">Actions</span></th></tr></thead><tbody>${rows}</tbody></table>`;
  wrap.querySelectorAll("[data-inbound-edit]").forEach((b) => {
    b.addEventListener("click", () => openInboundEditor(+b.getAttribute("data-inbound-edit")));
  });
  wrap.querySelectorAll("[data-inbound-del]").forEach((b) => {
    b.addEventListener("click", () => removeInboundRule(+b.getAttribute("data-inbound-del")));
  });
  wrap.querySelectorAll("input[data-inbound-disabled]").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("change", async () => {
      const idx = +inp.getAttribute("data-inbound-disabled");
      const wantEnabled = inp.checked;
      if (wantEnabled) {
        const r = (state.lastConfig.input_allows || [])[idx];
        if (!r || !String(r.dport || "").trim()) {
          setInboundMsg("Add a destination port in Edit before enabling this rule.", true);
          inp.checked = false;
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
  const protoSel = $("inbound-f-proto");
  const dport = $("inbound-f-dport");
  const note = $("inbound-f-note");
  if (!protoSel || !dport || !note) return;

  $("inbound-editor-msg").textContent = "";
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
    setInboundMsg("Protocol must be tcp or udp.", true, $("inbound-f-proto"));
    return;
  }
  const disEl = $("inbound-f-disabled");
  const enabled = disEl && disEl.checked;
  if (enabled && !dport) {
    setInboundMsg("Destination port is required.", true, $("inbound-f-dport"));
    return;
  }
  const entry = { proto };
  if (dport) entry.dport = dport;
  if (note) entry.note = note;
  entry.disabled = !enabled;
  const idxRaw = $("inbound-edit-index").value;
  const base = inboundEditBase;
  try {
    const cfg = await saveConfigEdit((c) => {
      if (!c.input_allows) c.input_allows = [];
      if (idxRaw === "") c.input_allows.push(entry);
      // The form replaces the whole row, so only a row still as it was when opened is safe to overwrite.
      else c.input_allows[findConfigRow(c.input_allows, +idxRaw, base, JSON.stringify, "inbound rule")] = entry;
    });
    setInboundMsg("Saved. Open Pending changes to review nftables, then Apply to host.");
    closeInboundEditor();
    renderInboundTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    if (e instanceof ConfigMergeError) {
      $("inbound-editor-msg").textContent =
        e.message + " Your values are still in this form: note them, press Cancel, and edit the latest version.";
      renderInboundTable(state.lastConfig);
    } else {
      setInboundMsg(String(e.message || e), true);
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

async function removeInboundRule(index) {
  const cfg = state.lastConfig;
  if (!cfg || !cfg.input_allows || cfg.input_allows[index] === undefined) return;
  const rule = cfg.input_allows[index];
  const identity = inboundRuleIdentity(rule);
  const openIndex = index;
  const proto = String(rule.proto || "").toLowerCase() || "—";
  const dport = String(rule.dport || "—");
  const note = String(rule.note || "").trim();
  const label = note ? proto + " " + dport + " (" + note + ")" : proto + " " + dport;
  openConfirmModal({
    title: "Remove inbound rule?",
    message:
      "Remove " +
      label +
      " from the saved config? The host is not updated until you apply on Pending changes.",
    confirmLabel: "Remove",
    onConfirm: async () => {
      try {
        // Re-resolve in the edit: the list may have changed while the dialog was open, or since this tab loaded.
        const c = await saveConfigEdit((draft) => {
          const i = findConfigRow(draft.input_allows, openIndex, identity, inboundRuleIdentity, "inbound rule");
          draft.input_allows.splice(i, 1);
        });
        setInboundMsg("Rule removed. Apply on Pending changes when ready.");
        renderInboundTable(c);
        setApiStatus(true);
        refreshPendingBadge();
      } catch (e) {
        setInboundMsg(String(e.message || e), true);
        renderInboundTable(state.lastConfig);
      }
    },
  });
}

export async function refreshInboundPage() {
  setInboundMsg("");
  try {
    state.lastConfig = await api("/v1/config");
    setApiStatus(true);
    renderInboundTable(state.lastConfig);
  } catch (e) {
    setApiStatus(false, String(e.message || e));
    setInboundMsg(String(e.message || e), true);
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
  $("inbound-cancel").addEventListener("click", closeInboundEditor);

  const inboundModal = $("inbound-modal");
  const inboundBackdrop = inboundModal && inboundModal.querySelector(".modal-backdrop");
  if (inboundBackdrop) inboundBackdrop.addEventListener("click", closeInboundEditor);
}
