import { state } from "./state.js";
import { $, clientIPSourceLabel, setApiStatus } from "./dom.js";
import { applyErrorText } from "./format.js";
import { api } from "./api.js";
import { showToast } from "./toast.js";
import { setTitlePendingCount } from "./title.js";
import { fetchValidateResult, lockoutRisks, lockoutSignature } from "./lockout.js";
import { adoptAppliedSession, confirmModeKnown, initApplySession, readApplyMode } from "./apply_session.js";

/*
 * The one Apply: a bar pinned above every page while changes are waiting, and the
 * result of the check and of the Apply pinned under it. Every Apply button comes
 * through here, so each one gets the lockout gate; see lockout.js for why that matters.
 */

const STEPS = ["validate", "firewall", "wireguard", "done"];
const STEP_LABELS = {
  validate: "Validating",
  firewall: "Applying firewall",
  wireguard: "Applying WireGuard",
  done: "Done",
};
const PROGRESS_POLL_MS = 400;
/** How long Done stays up. The toast says the same, so nothing is lost when it goes. */
const DONE_VISIBLE_MS = 4000;
const CONFIG_HASH_MISMATCH = "config_hash_mismatch";

let busy = false;
let doneTimer = 0;
let afterApply = async () => {};
/** The config revision last seen, to spot a result that no longer describes the config. */
let knownRevision = "";
/** The panel shows a pass with nothing to act on, so it need not follow the operator around. */
let showingCleanCheck = false;
/** The session a finished Apply started, until the screen has caught up and can show it. */
let pendingSession = null;

function syncResultVisibility() {
  $("apply-result").hidden =
    $("apply-progress").hidden &&
    $("pending-validate-panel").classList.contains("is-hidden") &&
    !$("apply-msg").textContent;
}

function setApplyMsg(text, isErr) {
  const el = $("apply-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
  syncResultVisibility();
}

/** Marks `step` as the one running, or as where things stopped when `failed`. */
function showProgress(step, failed) {
  const list = $("apply-progress");
  const at = STEPS.indexOf(step);
  list.hidden = false;
  list.querySelectorAll("[data-apply-step]").forEach((li, i) => {
    const current = i === at;
    li.classList.toggle("is-done", i < at || step === "done");
    li.classList.toggle("is-active", current && !failed && step !== "done");
    li.classList.toggle("is-failed", current && !!failed);
    if (current) li.setAttribute("aria-current", "step");
    else li.removeAttribute("aria-current");
  });
  $("apply-progress-status").textContent = STEP_LABELS[step] + (failed ? " failed" : "");
  syncResultVisibility();
}

function hideProgress() {
  clearTimeout(doneTimer);
  $("apply-progress").hidden = true;
  $("apply-progress-status").textContent = "";
  syncResultVisibility();
}

/**
 * One warning or error from /validate.
 *
 * The message is what the operator has to act on, so it leads; the machine code
 * follows in muted text for anyone matching it against the docs or a bug report.
 */
function validateFindingItem(finding) {
  const li = document.createElement("li");
  li.textContent = finding.message || String(finding);
  if (finding.code) {
    const code = document.createElement("span");
    code.className = "meta pending-validate-code";
    code.textContent = String(finding.code);
    li.append(" ", code);
  }
  return li;
}

/**
 * Paints the check result.
 *
 * Rendering only; the Apply gate reads the response, not the DOM. Deriving
 * "is there a lockout risk" here would make the gate depend on this function
 * running and on `#pending-validate-warnings` existing — a missing element would
 * fail open, which is the exact class of bug that left this panel unbuilt.
 */
function renderCheckResult(res) {
  const panel = $("pending-validate-panel");
  const ipLine = $("pending-client-ip");
  const warnUl = $("pending-validate-warnings");
  const ack = $("pending-lockout-ack");
  const risks = lockoutRisks(res);
  const warnings = Array.isArray(res.warnings) ? res.warnings : [];
  const errors = Array.isArray(res.errors) ? res.errors : [];

  panel.classList.remove("is-hidden");
  // Severity: failed check > any warning > clean.
  const severity = !res.ok
    ? "evu-alert--danger"
    : warnings.length
      ? "evu-alert--warning"
      : "evu-alert--success";
  panel.classList.remove("evu-alert--danger", "evu-alert--warning", "evu-alert--success");
  panel.classList.add(severity);

  const ip = res.detected_client_ip || "unknown";
  ipLine.textContent = "Your connection appears as: " + ip + " (" + clientIPSourceLabel(res.ip_detection_source) + ")";
  if (res.ip_detection_note) ipLine.textContent += ". " + res.ip_detection_note;

  warnUl.innerHTML = "";
  // Both lists, always: a config can fail nft -c *and* carry lockout risks,
  // and showing only the errors would hide the risks the operator must ack.
  errors.forEach((e) => warnUl.appendChild(validateFindingItem(e)));
  warnings.forEach((w) => warnUl.appendChild(validateFindingItem(w)));
  warnUl.classList.toggle("is-hidden", !errors.length && !warnings.length);

  // Keep an existing tick only when it was given for these exact warnings.
  const sig = lockoutSignature(risks);
  state.pendingValidateSig = sig;
  if (state.pendingLockoutAckSig !== sig) {
    state.pendingLockoutAckSig = "";
    ack.checked = false;
  }
  // With confirm-or-revert on, a lockout undoes itself, so there is nothing to acknowledge.
  $("pending-lockout-ack-wrap").classList.toggle("is-hidden", !risks.length || confirmModeKnown());
  showingCleanCheck = res.ok && !warnings.length;
  syncResultVisibility();
}

/**
 * Runs the pre-apply check and renders it. Returns the result, or null when the
 * check could not be completed (the message is already on screen).
 */
async function runCheck() {
  setApplyMsg("Checking config…");
  const { res, error } = await fetchValidateResult();
  if (!res) {
    invalidateCheck();
    setApplyMsg(error, true);
    return null;
  }
  renderCheckResult(res);
  setApplyMsg(
    res.ok ? "Config check passed (nft -c)." : "Config check failed; fix the errors below.",
    !res.ok
  );
  return res;
}

/**
 * Drops the result and any acknowledgement.
 *
 * Called whenever the config underneath may have moved. Apply re-runs the check
 * regardless, so this is about not showing a stale verdict — and about not
 * leaving a ticked box behind for a set of warnings that no longer applies.
 */
export function invalidateCheck() {
  state.pendingValidateSig = "";
  state.pendingLockoutAckSig = "";
  showingCleanCheck = false;
  $("pending-lockout-ack").checked = false;
  $("pending-lockout-ack-wrap").classList.add("is-hidden");
  $("pending-validate-panel").classList.add("is-hidden");
  if (!busy) hideProgress();
  setApplyMsg("");
}

/**
 * Check config, the secondary action: the verdict without the Apply. An Apply that is
 * already running has its own check, and this one would paint over its result.
 */
export async function checkConfig() {
  if (!busy) await runCheck();
}

/** A failed check or a risk stays through navigation, since the fix is usually on another page. */
export function dropPassedCheck() {
  if (!busy && showingCleanCheck && !$("apply-msg").classList.contains("err")) invalidateCheck();
}

/** Takes the saved config's revision from the server: a new one retires the result on screen. */
export function noteConfigRevision(revision) {
  if (!revision) return;
  if (knownRevision && revision !== knownRevision && !busy) invalidateCheck();
  knownRevision = revision;
}

/**
 * Sends the Apply, following its stages for as long as the one request takes. With
 * `confirmSeconds` the host reverts unless it is confirmed in that time. Any risks stay
 * on screen for that decision. `configHash` names the file the check passed, and the host
 * refuses the Apply if that is no longer the saved one. An API older than this UI sends
 * no hash and ignores this; a current one refuses an Apply without it. Never `force`:
 * that is for automation, and would take away the check this flow just ran.
 */
async function runReload(configHash, confirmSeconds, keepWarnings) {
  let step = "firewall";
  showProgress(step);
  setApplyMsg("");
  let polling = true;
  const poll = async () => {
    try {
      const p = await api("/v1/reload/progress");
      if (polling && STEPS.indexOf(p.step) > STEPS.indexOf(step)) {
        step = p.step;
        showProgress(step);
      }
    } catch {
      /* An API older than this UI has no progress to report; the steps just move less. */
    }
  };
  const timer = setInterval(() => void poll(), PROGRESS_POLL_MS);
  let session = null;
  try {
    const fields = {
      ...(configHash ? { config_hash: configHash } : {}),
      ...(confirmSeconds ? { confirm_timeout_seconds: confirmSeconds } : {}),
    };
    const res = await api("/v1/reload", {
      method: "POST",
      ...(Object.keys(fields).length ? { body: JSON.stringify(fields) } : {}),
    });
    session = (res && res.session) || null;
  } catch (e) {
    if (e.errorCode === CONFIG_HASH_MISMATCH) {
      // Nothing was applied. The tick and the verdict were for the config that's gone, and
      // the screen is still showing it. Refreshed here, while `busy` stops the new revision
      // clearing this message. A failed refresh has its own message and changes nothing.
      polling = false;
      clearInterval(timer);
      invalidateCheck();
      showProgress("validate", true);
      setApplyMsg("The saved config changed after this check, so nothing was applied. Review it, then Apply again.", true);
      await afterApply().catch(() => {});
      return false;
    }
    showProgress(step, true);
    setApplyMsg(applyErrorText(e), true);
    return false;
  } finally {
    polling = false;
    clearInterval(timer);
  }
  if (!keepWarnings) invalidateCheck();
  showProgress("done");
  doneTimer = setTimeout(hideProgress, DONE_VISIBLE_MS);
  setApiStatus(true);
  // The panel asking whether to keep it says what a toast would.
  if (!session) showToast("Applied to host");
  pendingSession = session;
  return true;
}

async function applyWithCheck() {
  // Read before the check, which needs to know whether to offer the acknowledgement.
  // An API that can't answer can't be trusted to apply safely either, so stop here.
  showProgress("validate");
  let mode;
  try {
    mode = await readApplyMode();
  } catch (e) {
    showProgress("validate", true);
    setApplyMsg(String(e.message || e), true);
    return false;
  }
  if (mode.failedRevert) {
    hideProgress();
    setApplyMsg("The last Apply hasn't finished reverting. Retry the revert before applying again.", true);
    return false;
  }
  // Always check immediately before applying. A stored "it passed earlier"
  // cannot know about a config saved since — in another tab, by the CLI, or
  // on another page of this one.
  const res = await runCheck();
  if (!res || !res.ok) {
    showProgress("validate", true);
    return false;
  }
  const risks = lockoutRisks(res);
  if (mode.confirm) return runReload(res.config_hash, mode.timeoutSeconds, risks.length > 0);
  if (risks.length) {
    const ack = $("pending-lockout-ack");
    if (!ack.checked || state.pendingLockoutAckSig !== lockoutSignature(risks)) {
      hideProgress();
      setApplyMsg("This config may lock you out. Read the warnings below, then tick the box and apply again.", true);
      ack.focus();
      return false;
    }
  }
  return runReload(res.config_hash, 0, false);
}

function onApplyClick(button) {
  return async () => {
    if (busy) return;
    busy = true;
    clearTimeout(doneTimer);
    // Not `disabled`: that would drop keyboard focus out of the bar mid-apply.
    button.setAttribute("aria-busy", "true");
    let applied = false;
    try {
      applied = await applyWithCheck();
    } finally {
      busy = false;
      button.removeAttribute("aria-busy");
    }
    if (applied) {
      // First: if the Apply blocked new connections, the refresh below gets no answer for
      // minutes. The panel's question is the next thing to answer, and taking focus now
      // also stops the bar hiding from moving it.
      adoptAppliedSession(pendingSession);
      pendingSession = null;
      await afterApply();
    }
  };
}

/** Updates everything that counts unapplied changes. Zero clears the bar. */
export function showUnappliedCount(count) {
  const bar = $("apply-bar");
  const label = count === 1 ? "1 unapplied change" : count + " unapplied changes";
  $("apply-bar-text").textContent = count ? label : "";
  const badge = $("nav-pending-count");
  badge.textContent = count ? String(count) : "";
  badge.hidden = !count;
  $("nav-pending-sr").textContent = count ? " (" + label + ")" : "";
  setTitlePendingCount(count);
  const hadFocus = bar.contains(document.activeElement);
  bar.hidden = !count;
  if (!count && hadFocus) $("main-content").focus({ preventScroll: true });
}

/** @param {{ afterApply: () => Promise<void> }} opts `afterApply` brings the screen up to date. */
export function initApplyBar(opts) {
  afterApply = opts.afterApply;
  for (const button of [$("apply-bar-apply"), $("pending-apply")]) {
    button.addEventListener("click", onApplyClick(button));
  }
  const ackBox = $("pending-lockout-ack");
  // Bind the tick to the warnings currently on screen. Re-validating on Apply
  // then revokes it automatically if the config moved in the meantime.
  ackBox.addEventListener("change", () => {
    state.pendingLockoutAckSig = ackBox.checked ? state.pendingValidateSig : "";
  });
  $("apply-result-dismiss").addEventListener("click", () => {
    invalidateCheck();
    hideProgress();
    $("main-content").focus({ preventScroll: true });
  });
  initApplySession({
    onSettled: async () => {
      invalidateCheck();
      await afterApply();
    },
  });
  // The region stays on screen as the page scrolls, so a field tabbed to must stop below it.
  const region = $("apply-region");
  new ResizeObserver(() => {
    document.documentElement.style.scrollPaddingTop = region.offsetHeight + "px";
  }).observe(region);
}
