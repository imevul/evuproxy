import { state } from "../core/state.js";
import { $, escapeHtml, setApiStatus, tableDisabledToggleCell } from "../core/dom.js";
import { api } from "../core/api.js";
import { openModal, closeModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

async function patchInboundDisabled(index, disabled) {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.input_allows || cfg.input_allows[index] === undefined) return;
  cfg.input_allows[index].disabled = disabled;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
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
function setInboundMsg(text, isErr) {
  const el = $("inbound-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function renderInboundTable(cfg) {
  const wrap = $("inbound-table-wrap");
  if (!wrap) return;
  const rules = cfg.input_allows || [];

  if (!rules.length) {
    wrap.innerHTML =
      "<p class=\"hint\">No extra INPUT rules. Add one for SSH, HTTP, or other host services (<code class=\"inline\">input_allows</code>).</p>";
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
        `<tr><td class="mono">${escapeHtml(String(r.proto || "").toLowerCase())}</td><td class="mono">${escapeHtml(r.dport || "")}</td><td>${escapeHtml(r.note || "—")}</td>${tableDisabledToggleCell("data-inbound-disabled", i, !!r.disabled, aria)}<td class="row-actions"><button type="button" data-inbound-edit="${i}">Edit</button> <button type="button" data-inbound-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      );
    })
    .join("");
  wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Port(s)</th><th>Note</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.input_allows) cfg.input_allows = [];
  const proto = ($("inbound-f-proto").value || "tcp").toLowerCase();
  const dport = $("inbound-f-dport").value.trim();
  const note = $("inbound-f-note").value.trim();
  if (proto !== "tcp" && proto !== "udp") {
    setInboundMsg("Protocol must be tcp or udp.", true);
    return;
  }
  const disEl = $("inbound-f-disabled");
  const enabled = disEl && disEl.checked;
  if (enabled && !dport) {
    setInboundMsg("Destination port is required.", true);
    return;
  }
  const entry = { proto };
  if (dport) entry.dport = dport;
  if (note) entry.note = note;
  entry.disabled = !enabled;
  const idxRaw = $("inbound-edit-index").value;
  if (idxRaw === "") cfg.input_allows.push(entry);
  else cfg.input_allows[+idxRaw] = entry;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setInboundMsg("Saved. Open Pending changes to review nftables, then Apply to host.");
    closeInboundEditor();
    renderInboundTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    setInboundMsg(String(e.message || e), true);
  }
}

async function removeInboundRule(index) {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.input_allows) return;
  cfg.input_allows.splice(index, 1);
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setInboundMsg("Rule removed. Apply on Pending changes when ready.");
    renderInboundTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    setInboundMsg(String(e.message || e), true);
  }
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
