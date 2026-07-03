import { state } from "../core/state.js";
import { $, escapeHtml, setApiStatus, clientIPSourceLabel } from "../core/dom.js";
import { api } from "../core/api.js";
import { openConfirmModal } from "../core/modal.js";

function renderPendingValidateResult(res) {
  const panel = $("pending-validate-panel");
  const ipLine = $("pending-client-ip");
  const warnUl = $("pending-validate-warnings");
  const ackWrap = $("pending-lockout-ack-wrap");
  const ack = $("pending-lockout-ack");
  if (panel) panel.classList.remove("is-hidden");
  if (ipLine) {
    const ip = res.detected_client_ip || "unknown";
    const badge = clientIPSourceLabel(res.ip_detection_source);
    ipLine.textContent = "Your connection appears as: " + ip + " (" + badge + ")";
    if (res.ip_detection_note) {
      ipLine.textContent += ". " + res.ip_detection_note;
    }
  }
  state.pendingValidateHasLockout = false;
  if (warnUl) {
    warnUl.innerHTML = "";
    const warnings = res.warnings || [];
    const errors = res.errors || [];
    if (!res.ok && errors.length) {
      errors.forEach((e) => {
        const li = document.createElement("li");
        li.textContent = (e.code ? "[" + e.code + "] " : "") + (e.message || String(e));
        warnUl.appendChild(li);
      });
      warnUl.classList.remove("is-hidden");
    } else if (warnings.length) {
      warnings.forEach((w) => {
        const li = document.createElement("li");
        li.textContent = (w.code ? "[" + w.code + "] " : "") + (w.message || String(w));
        warnUl.appendChild(li);
        if (w.code && String(w.code).startsWith("lockout_risk_")) state.pendingValidateHasLockout = true;
      });
      warnUl.classList.remove("is-hidden");
    } else {
      warnUl.classList.add("is-hidden");
    }
  }
  if (ackWrap) ackWrap.classList.toggle("is-hidden", !state.pendingValidateHasLockout);
  if (ack) ack.checked = false;
}

async function runPendingValidate() {
  setPendingMsg("Checking config…");
  try {
    const res = await api("/v1/validate", { method: "POST" });
    renderPendingValidateResult(res);
    setPendingMsg(res.ok ? "Config check passed (nft -c)." : "Config check failed.", !res.ok);
  } catch (e) {
    setPendingMsg(String(e.message || e), true);
  }
}

function setPendingMsg(text, isErr) {
  const el = $("pending-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

const PENDING_DIFF_MODE_KEY = "evuproxy_pending_diff_mode";
/** Production nftables can be much larger than dev mocks; cap limits memory (~lcsLen + dirs). */
const LINE_DIFF_MAX_CELLS = 12_000_000;
const LINE_DIFF_MAX_SIDE = 6000;
const CHAR_DIFF_MAX_CELLS = 500_000;
const CHAR_DIFF_MAX_LEN = 4096;

function getPendingDiffMode() {
  try {
    const m = sessionStorage.getItem(PENDING_DIFF_MODE_KEY);
    if (m === "split" || m === "unified") return m;
  } catch (e) {
    /* ignore */
  }
  return "unified";
}

function setPendingDiffMode(mode) {
  try {
    sessionStorage.setItem(PENDING_DIFF_MODE_KEY, mode);
  } catch (e) {
    /* ignore */
  }
}

function splitLines(text) {
  if (text.length === 0) return [];
  return String(text).replace(/\r\n/g, "\n").split("\n");
}

function mergeCharOps(ops) {
  const merged = [];
  for (const op of ops) {
    const last = merged[merged.length - 1];
    if (last && last.type === op.type) {
      last.text += op.text;
    } else {
      merged.push({ type: op.type, text: op.text });
    }
  }
  return merged;
}

function computeLineDiff(oldLines, newLines) {
  const m = oldLines.length;
  const n = newLines.length;
  if (m > LINE_DIFF_MAX_SIDE || n > LINE_DIFF_MAX_SIDE || m * n > LINE_DIFF_MAX_CELLS) {
    return null;
  }
  try {
    const cols = n + 1;
    const idx = (i, j) => i * cols + j;
    const lcsLen = new Uint32Array((m + 1) * (n + 1));
    const dirs = new Int8Array((m + 1) * (n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (oldLines[i - 1] === newLines[j - 1]) {
          lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j - 1)] + 1;
          dirs[idx(i, j)] = 1;
        } else if (lcsLen[idx(i - 1, j)] >= lcsLen[idx(i, j - 1)]) {
          lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j)];
          dirs[idx(i, j)] = 2;
        } else {
          lcsLen[idx(i, j)] = lcsLen[idx(i, j - 1)];
          dirs[idx(i, j)] = 3;
        }
      }
    }
    const ops = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dirs[idx(i, j)] === 1) {
        ops.unshift({ type: "equal", oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dirs[idx(i, j)] === 3)) {
        ops.unshift({ type: "insert", line: newLines[j - 1] });
        j--;
      } else if (i > 0) {
        ops.unshift({ type: "delete", line: oldLines[i - 1] });
        i--;
      } else {
        break;
      }
    }
    return ops;
  } catch (e) {
    return null;
  }
}

function computeCharDiff(oldStr, newStr) {
  const a = oldStr.split("");
  const b = newStr.split("");
  const m = a.length;
  const n = b.length;
  if (m > CHAR_DIFF_MAX_LEN || n > CHAR_DIFF_MAX_LEN || m * n > CHAR_DIFF_MAX_CELLS) {
    return null;
  }
  const cols = n + 1;
  const idx = (i, j) => i * cols + j;
  const lcsLen = new Uint32Array((m + 1) * (n + 1));
  const dirs = new Int8Array((m + 1) * (n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j - 1)] + 1;
        dirs[idx(i, j)] = 1;
      } else if (lcsLen[idx(i - 1, j)] >= lcsLen[idx(i, j - 1)]) {
        lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j)];
        dirs[idx(i, j)] = 2;
      } else {
        lcsLen[idx(i, j)] = lcsLen[idx(i, j - 1)];
        dirs[idx(i, j)] = 3;
      }
    }
  }
  const raw = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && dirs[idx(i, j)] === 1) {
      raw.unshift({ type: "equal", text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dirs[idx(i, j)] === 3)) {
      raw.unshift({ type: "insert", text: b[j - 1] });
      j--;
    } else if (i > 0) {
      raw.unshift({ type: "delete", text: a[i - 1] });
      i--;
    } else {
      break;
    }
  }
  return mergeCharOps(raw);
}

function intralinePairHtml(oldLine, newLine) {
  if (oldLine === newLine) {
    const e = escapeHtml(oldLine);
    return { delHtml: e, insHtml: e };
  }
  if (!oldLine) {
    return {
      delHtml: "",
      insHtml: `<span class="diff-ch-strong diff-ch-ins">${escapeHtml(newLine)}</span>`,
    };
  }
  if (!newLine) {
    return {
      delHtml: `<span class="diff-ch-strong diff-ch-del">${escapeHtml(oldLine)}</span>`,
      insHtml: "",
    };
  }
  const ops = computeCharDiff(oldLine, newLine);
  if (!ops) {
    return { delHtml: escapeHtml(oldLine), insHtml: escapeHtml(newLine) };
  }
  let delH = "";
  let insH = "";
  for (const op of ops) {
    if (op.type === "equal") {
      const e = escapeHtml(op.text);
      delH += e;
      insH += e;
    } else if (op.type === "delete") {
      delH += `<span class="diff-ch-strong diff-ch-del">${escapeHtml(op.text)}</span>`;
    } else {
      insH += `<span class="diff-ch-strong diff-ch-ins">${escapeHtml(op.text)}</span>`;
    }
  }
  return { delHtml: delH, insHtml: insH };
}

function renderUnifiedDiffHtml(ops) {
  const rows = [];
  let oldNum = 0;
  let newNum = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "equal") {
      oldNum++;
      newNum++;
      rows.push(
        `<tr class="diff-row-ctx"><td class="diff-ln">${oldNum}</td><td class="diff-ln">${newNum}</td><td class="diff-sign"></td><td class="diff-code">${escapeHtml(
          op.oldLine
        )}</td></tr>`
      );
      continue;
    }
    if (op.type === "delete") {
      const next = ops[i + 1];
      if (next && next.type === "insert") {
        const { delHtml, insHtml } = intralinePairHtml(op.line, next.line);
        oldNum++;
        rows.push(
          `<tr class="diff-row-diff-del"><td class="diff-ln">${oldNum}</td><td class="diff-ln"></td><td class="diff-sign">-</td><td class="diff-code">${delHtml}</td></tr>`
        );
        newNum++;
        rows.push(
          `<tr class="diff-row-diff-ins"><td class="diff-ln"></td><td class="diff-ln">${newNum}</td><td class="diff-sign">+</td><td class="diff-code">${insHtml}</td></tr>`
        );
        i++;
        continue;
      }
      oldNum++;
      rows.push(
        `<tr class="diff-row-diff-del"><td class="diff-ln">${oldNum}</td><td class="diff-ln"></td><td class="diff-sign">-</td><td class="diff-code">${escapeHtml(
          op.line
        )}</td></tr>`
      );
      continue;
    }
    if (op.type === "insert") {
      newNum++;
      rows.push(
        `<tr class="diff-row-diff-ins"><td class="diff-ln"></td><td class="diff-ln">${newNum}</td><td class="diff-sign">+</td><td class="diff-code">${escapeHtml(
          op.line
        )}</td></tr>`
      );
    }
  }
  return `<div class="pending-diff-scroll"><table class="pending-diff-unified"><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderSplitDiffHtml(ops) {
  /** Keeps row height aligned between the two independent tables (empty td can collapse). */
  const padCell = '<td class="diff-split-ln"></td><td class="diff-split-code diff-split-pad">&nbsp;</td>';
  const leftRows = [];
  const rightRows = [];
  let oldNum = 0;
  let newNum = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.type === "equal") {
      oldNum++;
      newNum++;
      leftRows.push(
        `<tr class="diff-split-row diff-split-row-ctx"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${escapeHtml(
          op.oldLine
        )}</td></tr>`
      );
      rightRows.push(
        `<tr class="diff-split-row diff-split-row-ctx"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${escapeHtml(
          op.newLine
        )}</td></tr>`
      );
      continue;
    }
    if (op.type === "delete") {
      const next = ops[i + 1];
      if (next && next.type === "insert") {
        const { delHtml, insHtml } = intralinePairHtml(op.line, next.line);
        oldNum++;
        newNum++;
        leftRows.push(
          `<tr class="diff-split-row diff-split-row-both-l"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${delHtml}</td></tr>`
        );
        rightRows.push(
          `<tr class="diff-split-row diff-split-row-both-r"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${insHtml}</td></tr>`
        );
        i++;
        continue;
      }
      oldNum++;
      leftRows.push(
        `<tr class="diff-split-row diff-split-row-del"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${escapeHtml(
          op.line
        )}</td></tr>`
      );
      rightRows.push(`<tr class="diff-split-row diff-split-row-gap">${padCell}</tr>`);
      continue;
    }
    if (op.type === "insert") {
      newNum++;
      leftRows.push(`<tr class="diff-split-row diff-split-row-gap">${padCell}</tr>`);
      rightRows.push(
        `<tr class="diff-split-row diff-split-row-ins"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${escapeHtml(
          op.line
        )}</td></tr>`
      );
    }
  }
  return (
    `<div class="pending-diff-split-view">` +
    `<div class="pending-diff-split-pane" data-pending-split-pane="left" tabindex="-1"><table class="pending-diff-split-side"><tbody>${leftRows.join(
      ""
    )}</tbody></table></div>` +
    `<div class="pending-diff-split-pane" data-pending-split-pane="right" tabindex="-1"><table class="pending-diff-split-side"><tbody>${rightRows.join(
      ""
    )}</tbody></table></div>` +
    `</div>`
  );
}

/** Link vertical scroll between split panes; horizontal scroll stays independent per pane. */
function setupPendingSplitScrollSync(panel) {
  const view = panel && panel.querySelector(".pending-diff-split-view");
  if (!view) return;
  const panes = view.querySelectorAll(".pending-diff-split-pane");
  if (panes.length !== 2) return;
  const left = panes[0];
  const right = panes[1];
  let lock = false;
  function syncFrom(src, dst) {
    if (lock) return;
    if (dst.scrollTop === src.scrollTop) return;
    lock = true;
    dst.scrollTop = src.scrollTop;
    lock = false;
  }
  left.addEventListener("scroll", () => syncFrom(left, right), { passive: true });
  right.addEventListener("scroll", () => syncFrom(right, left), { passive: true });
}

function renderPendingDiffTooLarge(oldText, newText, mode, oldLineCount, newLineCount) {
  const lc =
    oldLineCount != null && newLineCount != null
      ? ` (${oldLineCount} vs ${newLineCount} lines — product exceeds browser limit).`
      : ".";
  const hint =
    `<p class="hint pending-diff-same">Diff too large to compute in the browser${lc} Showing full texts below; use an external diff if you need line-level detail.</p>`;
  if (mode === "split") {
    return (
      hint +
      `<div class="pending-diff-split-view">` +
      `<div class="pending-diff-split-pane" data-pending-split-pane="left" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(oldText)}</pre></div>` +
      `<div class="pending-diff-split-pane" data-pending-split-pane="right" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(newText)}</pre></div>` +
      `</div>`
    );
  }
  return (
    hint +
    `<h4 class="pending-diff-raw-h">Baseline (<code>generated/nftables.nft</code>)</h4>` +
    `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(oldText)}</pre>` +
    `<h4 class="pending-diff-raw-h">Proposed (current saved config)</h4>` +
    `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(newText)}</pre>`
  );
}

function renderPendingDiffPanel() {
  const panel = $("pending-diff-panel");
  const uBtn = $("pending-mode-unified");
  const sBtn = $("pending-mode-split");
  if (!panel) return;
  const mode = getPendingDiffMode();
  if (uBtn && sBtn) {
    uBtn.classList.toggle("is-active", mode === "unified");
    sBtn.classList.toggle("is-active", mode === "split");
    uBtn.setAttribute("aria-selected", mode === "unified" ? "true" : "false");
    sBtn.setAttribute("aria-selected", mode === "split" ? "true" : "false");
  }
  panel.setAttribute("aria-labelledby", mode === "unified" ? "pending-mode-unified" : "pending-mode-split");
  const oldText = state.lastPendingBaseline;
  const newText = state.lastPendingNew;
  const baselineHint =
    oldText === "" && newText !== ""
      ? `<p class="hint pending-diff-baseline-missing">No readable on-disk <code class="inline">generated/nftables.nft</code> (missing, unreadable, or API older than baseline support). The left column compares against an empty baseline; reload the host after a successful apply to populate the file.</p>`
      : "";
  if (oldText === newText) {
    let body = `<p class="hint pending-diff-same">No differences.</p>`;
    if (newText) {
      body += `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(newText)}</pre>`;
    }
    panel.innerHTML = body;
    return;
  }
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const ops = computeLineDiff(oldLines, newLines);
  if (!ops) {
    panel.innerHTML =
      baselineHint + renderPendingDiffTooLarge(oldText, newText, mode, oldLines.length, newLines.length);
    if (mode === "split") setupPendingSplitScrollSync(panel);
    return;
  }
  if (mode === "split") {
    panel.innerHTML = baselineHint + renderSplitDiffHtml(ops);
    setupPendingSplitScrollSync(panel);
  } else {
    panel.innerHTML = baselineHint + renderUnifiedDiffHtml(ops);
  }
}

export async function refreshPendingBadge() {
  const dot = $("nav-pending-dot");
  if (!dot) return;
  try {
    const p = await api("/v1/pending");
    dot.classList.toggle("is-hidden", !p.pending);
    dot.title = p.pending ? "Saved config not yet applied to host" : "";
  } catch {
    dot.classList.add("is-hidden");
  }
}

export async function refreshPendingPage() {
  const status = $("pending-status");
  const panel = $("pending-diff-panel");
  if (!status || !panel) return;
  setPendingMsg("");
  try {
    const p = await api("/v1/pending");
    setApiStatus(true);
    if (p.pending) {
      status.textContent =
        "Unapplied changes: the saved config on disk differs from the last successful reload (nftables / WireGuard).";
      status.classList.remove("pending-no");
      status.classList.add("pending-yes");
    } else {
      status.textContent =
        "No pending changes. Saved config matches what was last applied on the host.";
      status.classList.remove("pending-yes");
      status.classList.add("pending-no");
    }
    state.lastPendingBaseline = p.nftables_baseline != null ? String(p.nftables_baseline) : "";
    state.lastPendingNew = p.nftables != null ? String(p.nftables) : "";
    const discardBtn = $("pending-discard");
    if (discardBtn) discardBtn.disabled = !p.discard_available;
    const restoreBtn = $("pending-restore-previous");
    if (restoreBtn) restoreBtn.disabled = !p.restore_previous_applied_available;
    renderPendingDiffPanel();
  } catch (e) {
    status.textContent = "";
    status.classList.remove("pending-yes", "pending-no");
    state.lastPendingBaseline = "";
    state.lastPendingNew = "";
    const discardErr = $("pending-discard");
    if (discardErr) discardErr.disabled = true;
    const restoreErr = $("pending-restore-previous");
    if (restoreErr) restoreErr.disabled = true;
    panel.innerHTML = "";
    setApiStatus(false, String(e.message || e));
    setPendingMsg(String(e.message || e), true);
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initPendingPage() {
  $("pending-refresh").addEventListener("click", refreshPendingPage);
  const pendingModeUnified = $("pending-mode-unified");
  const pendingModeSplit = $("pending-mode-split");
  if (pendingModeUnified) {
    pendingModeUnified.addEventListener("click", () => {
      setPendingDiffMode("unified");
      renderPendingDiffPanel();
    });
  }
  if (pendingModeSplit) {
    pendingModeSplit.addEventListener("click", () => {
      setPendingDiffMode("split");
      renderPendingDiffPanel();
    });
  }
  const pendingCheck = $("pending-check-config");
  if (pendingCheck) pendingCheck.addEventListener("click", () => void runPendingValidate());

  $("pending-apply").addEventListener("click", async () => {
    if (state.pendingValidateHasLockout) {
      const ack = $("pending-lockout-ack");
      if (!ack || !ack.checked) {
        setPendingMsg("Check config and confirm you understand the lockout risks before applying.", true);
        return;
      }
    }
    setPendingMsg("…");
    try {
      await api("/v1/reload", { method: "POST" });
      setPendingMsg("Applied to host.");
      await refreshPendingPage();
      await refreshPendingBadge();
      setApiStatus(true);
    } catch (e) {
      setPendingMsg(String(e.message || e), true);
    }
  });

  const pendingDiscard = $("pending-discard");
  if (pendingDiscard) {
    pendingDiscard.addEventListener("click", () => {
      openConfirmModal({
        title: "Discard pending?",
        message:
          "Replace the saved config.yaml with config.yaml.bak (the last applied snapshot). Unsaved edits that differ from that snapshot are lost. The host is not updated until you apply or reload.",
        confirmLabel: "Discard pending",
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/discard", { method: "POST" });
            setPendingMsg("Pending changes discarded. Apply or reload when ready.");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }

  const pendingRestore = $("pending-restore-previous");
  if (pendingRestore) {
    pendingRestore.addEventListener("click", () => {
      openConfirmModal({
        title: "Restore previous applied?",
        message:
          "Replace config.yaml with the first older snapshot in config.yaml.bak.1 … .bak.5 that differs from config.yaml.bak. Any current config.yaml content is overwritten (including edits not yet applied to the host). The host is not updated until you apply or reload.",
        confirmLabel: "Restore",
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/restore-previous-applied", { method: "POST" });
            setPendingMsg("Restored previous applied config. Apply or reload when ready.");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }
}
