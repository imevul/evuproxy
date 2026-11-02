import { state } from "../core/state.js";
import { $, escapeHtml, setApiStatus } from "../core/dom.js";
import { beginLoading } from "../core/loading.js";
import { api, responseEtag } from "../core/api.js";
import { markPageLoaded } from "../core/connection.js";
import { showToast } from "../core/toast.js";
import { openConfirmModal } from "../core/modal.js";
import { checkConfig, invalidateCheck, noteConfigRevision, showUnappliedCount } from "../core/apply_bar.js";
import { saveConfigEdit } from "../core/config_save.js";
import { describeConfigChanges, revertChange, reapplyChange } from "../core/config_changes.js";
import { showUndoToast } from "../core/undo.js";

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
  // tabindex + a name: the diff scrolls, so keyboard users need to be able to
  // land on it and use the arrow keys like everyone else.
  return `<div class="pending-diff-scroll scroll-thin" tabindex="0" role="group" aria-label="Unified diff"><table class="pending-diff-unified"><tbody>${rows.join(
    ""
  )}</tbody></table></div>`;
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
    // Both panes are tab stops: vertical scrolling is synced between them but
    // horizontal scrolling is per pane, so each needs its own keyboard entry.
    `<div class="pending-diff-split-pane scroll-thin" data-pending-split-pane="left" tabindex="0" role="group" aria-label="Current version"><table class="pending-diff-split-side"><tbody>${leftRows.join(
      ""
    )}</tbody></table></div>` +
    `<div class="pending-diff-split-pane scroll-thin" data-pending-split-pane="right" tabindex="0" role="group" aria-label="After apply"><table class="pending-diff-split-side"><tbody>${rightRows.join(
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
      `<div class="pending-diff-split-pane scroll-thin" data-pending-split-pane="left" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(oldText)}</pre></div>` +
      `<div class="pending-diff-split-pane scroll-thin" data-pending-split-pane="right" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(newText)}</pre></div>` +
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
      ? `<p class="hint pending-diff-baseline-missing">No readable on-disk <code class="inline">generated/nftables.nft</code> (missing, unreadable, or API older than baseline support). The left column compares against an empty baseline; a successful Apply populates the file.</p>`
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

function changeCount(n) {
  return n === 1 ? "1 change" : n + " changes";
}

/** What the Changes list is showing, by position. Revert buttons refer to these. */
let listedChanges = [];
/** One revert at a time: the list re-renders after each, so positions would move. */
let revertBusy = false;

function setChangesMsg(text, isErr) {
  const el = $("pending-changes-msg");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

/**
 * `applied_config` is null when the host's config is not known, and absent on an API
 * older than this UI (the two deploy separately). The rules diff is then the only review,
 * so it opens by itself.
 */
function renderChangesList(p, cfg) {
  const section = $("pending-changes");
  const list = $("pending-changes-list");
  const note = $("pending-changes-note");
  const rawDiff = $("pending-raw-diff");
  if (!section || !list || !note) return;
  const comparable = !!p.applied_config;
  listedChanges = p.pending && comparable ? describeConfigChanges(p.applied_config, cfg) : [];
  list.innerHTML = "";
  listedChanges.forEach((change, i) => {
    const li = document.createElement("li");
    li.className = "pending-change";
    const text = document.createElement("span");
    text.className = "pending-change__text";
    text.textContent = change.text;
    const revert = document.createElement("button");
    revert.type = "button";
    revert.className = "evu-btn evu-btn--outline evu-btn--sm";
    revert.textContent = "Revert";
    revert.setAttribute("aria-label", "Revert: " + change.text);
    revert.dataset.changeRevert = String(i);
    li.append(text, revert);
    list.appendChild(li);
  });
  section.classList.toggle("is-hidden", !p.pending);
  list.classList.toggle("is-hidden", !listedChanges.length);
  note.classList.toggle("is-hidden", !p.pending || !!listedChanges.length);
  if (p.pending && !comparable) {
    note.textContent =
      "The config last applied to this host is not available to compare, so changes cannot be listed. Review the generated nftables below.";
  } else if (p.pending) {
    note.textContent = "The saved settings match what was applied. Only comments or formatting in the file differ.";
  }
  if (rawDiff && p.pending && !comparable) rawDiff.open = true;
}

/**
 * Where focus goes once a row has left the list: the row now in its place, else the heading.
 * With nothing left pending the Changes section is hidden and cannot take focus, so the page heading does.
 */
function focusChangeAt(index) {
  const buttons = document.querySelectorAll("#pending-changes-list [data-change-revert]");
  const heading = $("pending-changes").classList.contains("is-hidden") ? "pending-page-title" : "pending-changes-title";
  const target = buttons[Math.min(index, buttons.length - 1)] || $(heading);
  if (target) target.focus();
}

async function afterChangesSaved(focusIndex) {
  await refreshPendingPage();
  await refreshPendingBadge();
  if (focusIndex !== null) focusChangeAt(focusIndex);
}

async function revertListedChange(index) {
  const change = listedChanges[index];
  if (revertBusy || !change) return;
  revertBusy = true;
  setChangesMsg("");
  try {
    let reverted = false;
    await saveConfigEdit((draft) => {
      reverted = revertChange(draft, change);
      return reverted;
    });
    setApiStatus(true);
    await afterChangesSaved(index);
    if (!reverted) {
      showToast("Already gone: " + change.text + ".");
      return;
    }
    showUndoToast("Reverted: " + change.text + ".", {
      page: "pending",
      edit: (draft) => reapplyChange(draft, change),
      afterSave: (_cfg, focus) => void afterChangesSaved(focus ? index : null),
      message: () => "Back in place: " + change.text + ".",
    });
  } catch (e) {
    // The save may have adopted fresh config, and this message has no time limit, unlike a toast.
    await afterChangesSaved(index);
    setChangesMsg("Could not revert: " + String(e.message || e), true);
  } finally {
    revertBusy = false;
  }
}

/** Counts for a confirmation, fresh because the page may be stale. The dialog can go without them. */
async function fetchPendingCounts() {
  try {
    return await api("/v1/pending");
  } catch {
    return {};
  }
}

/**
 * How many separate places the ruleset changes in. An estimate, for when the Changes
 * list has no rows to count. A pending edit that leaves the ruleset alone (a note, say)
 * still counts as one.
 */
function rulesetChangeCount(p) {
  const ops = computeLineDiff(splitLines(String(p.nftables_baseline ?? "")), splitLines(String(p.nftables ?? "")));
  if (!ops) return 1;
  let count = 0;
  let inChange = false;
  for (const op of ops) {
    const changed = op.type !== "equal";
    if (changed && !inChange) count++;
    inChange = changed;
  }
  return Math.max(count, 1);
}

/** The rows on the Changes list, so the count and the list agree. */
function unappliedCount(p, cfg) {
  const rows = cfg ? describeConfigChanges(p.applied_config, cfg).length : 0;
  return rows || rulesetChangeCount(p);
}

/** The saved config, without a second request when the page on screen just loaded this revision. */
function savedConfig(p) {
  const loaded = state.lastConfig;
  return loaded && responseEtag(loaded) === '"' + p.current_config_sha256 + '"' ? loaded : api("/v1/config");
}

/* Saves and navigation both refresh this, so an earlier answer can land after a later one. */
let pendingBadgeSeq = 0;

export async function refreshPendingBadge() {
  const seq = ++pendingBadgeSeq;
  try {
    const p = await api("/v1/pending");
    const cfg = p.pending && p.applied_config ? await savedConfig(p) : null;
    if (seq !== pendingBadgeSeq) return;
    noteConfigRevision(p.current_config_sha256);
    showUnappliedCount(p.pending ? unappliedCount(p, cfg) : 0);
  } catch {
    /* Not knowing isn't "nothing to apply", so the last count stays. */
  }
}

/** Tones the banner alert: "warning" when unapplied, "neutral" when clean, "hidden" on error. */
function setPendingStatusTone(tone) {
  const alert = $("pending-status-alert");
  if (!alert) return;
  alert.classList.toggle("evu-alert--warning", tone === "warning");
  alert.classList.toggle("is-hidden", tone === "hidden");
}

/* Once this page has loaded, a failed refresh leaves that on screen. */
let pendingPageLoaded = false;

export async function refreshPendingPage() {
  const status = $("pending-status");
  const panel = $("pending-diff-panel");
  if (!status || !panel) return;
  setPendingMsg("");
  setChangesMsg("");
  const doneLoading = beginLoading("pending-changes-list", "pending-diff-panel");
  try {
    const [p, cfg] = await Promise.all([api("/v1/pending"), api("/v1/config")]);
    state.lastConfig = cfg;
    setApiStatus(true);
    renderChangesList(p, cfg);
    if (p.pending) {
      status.textContent =
        "Unapplied changes: the saved config on disk differs from the last successful Apply (nftables / WireGuard).";
      setPendingStatusTone("warning");
    } else {
      status.textContent =
        "No pending changes. Saved config matches what was last applied on the host.";
      setPendingStatusTone("neutral");
    }
    state.lastPendingBaseline = p.nftables_baseline != null ? String(p.nftables_baseline) : "";
    state.lastPendingNew = p.nftables != null ? String(p.nftables) : "";
    const discardBtn = $("pending-discard");
    if (discardBtn) discardBtn.disabled = !p.discard_available;
    const restoreBtn = $("pending-restore-previous");
    if (restoreBtn) restoreBtn.disabled = !p.restore_previous_applied_available;
    renderPendingDiffPanel();
    pendingPageLoaded = true;
    markPageLoaded("pending");
  } catch (e) {
    if (!pendingPageLoaded) {
      status.textContent = "";
      setPendingStatusTone("hidden");
      const discardErr = $("pending-discard");
      if (discardErr) discardErr.disabled = true;
      const restoreErr = $("pending-restore-previous");
      if (restoreErr) restoreErr.disabled = true;
    }
    setApiStatus(false, String(e.message || e));
    setPendingMsg(String(e.message || e), true);
  } finally {
    doneLoading();
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initPendingPage() {
  $("pending-refresh").addEventListener("click", () => {
    // Refresh is the operator saying the config may have moved, so the earlier result goes too.
    invalidateCheck();
    void refreshPendingPage();
  });
  $("pending-changes-list").addEventListener("click", (e) => {
    const revert = e.target.closest("[data-change-revert]");
    if (revert) void revertListedChange(+revert.dataset.changeRevert);
  });
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
  if (pendingCheck) pendingCheck.addEventListener("click", () => void checkConfig());

  const pendingDiscard = $("pending-discard");
  if (pendingDiscard) {
    pendingDiscard.addEventListener("click", async () => {
      const changes = (await fetchPendingCounts()).discard_change_count;
      const what = changes ? changeCount(changes) : "pending changes";
      openConfirmModal({
        title: "Discard " + what + "?",
        message:
          "Replace the saved config.yaml with config.yaml.bak (the last applied snapshot). Unsaved edits that differ from that snapshot are lost. The host is not updated until you apply.",
        confirmLabel: "Discard " + what,
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/discard", { method: "POST" });
            setPendingMsg("");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
            showToast("Pending changes discarded.");
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }

  const pendingRestore = $("pending-restore-previous");
  if (pendingRestore) {
    pendingRestore.addEventListener("click", async () => {
      const changes = (await fetchPendingCounts()).restore_previous_change_count;
      openConfirmModal({
        title: "Restore previous applied?",
        message:
          (changes ? "This changes " + changeCount(changes) + " in the saved config. " : "") +
          "Replace config.yaml with the first older snapshot in config.yaml.bak.1 … .bak.5 that differs from config.yaml.bak. Any current config.yaml content is overwritten (including edits not yet applied to the host). The host is not updated until you apply.",
        confirmLabel: "Restore previous config",
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/restore-previous-applied", { method: "POST" });
            setPendingMsg("");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
            showToast("Previous applied config restored.");
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }
}
