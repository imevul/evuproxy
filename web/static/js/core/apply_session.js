import { $, setApiStatus } from "./dom.js";
import { api, token } from "./api.js";
import { showToast } from "./toast.js";

/*
 * "Applied. Keep these changes? Reverting in 60s."
 *
 * The revert itself runs on the host from a systemd timer, so nothing here is needed for
 * it to happen: an operator who has just locked themselves out can't load this page at
 * all. The panel only shows the countdown and offers to decide early. It reads everything
 * from the API, so it picks the countdown up after a page reload, in another tab, or when
 * the CLI started the session, and it reports a revert that happened while nobody watched.
 */

const POLL_SESSION_MS = 3000;
const POLL_IDLE_MS = 30000;
const TICK_MS = 250;
/**
 * nginx closes every connection after one response, so each request here opens a new one,
 * and a firewall that blocks new connections drops it without an answer. Without a limit
 * the browser keeps retrying for minutes, and those retries get through once the firewall
 * has reverted, so a late Keep could land after the session it was meant for. A slow
 * revert can pass the limit too and carries on regardless: the session read still answers
 * during one, so the re-read after the limit shows it reverting.
 */
const REQUEST_TIMEOUT_MS = 15000;
const NO_ANSWER = "No answer from the host over a new connection.";
/** Screen readers hear the start and this last warning, not every second. */
const WARN_AT_SECONDS = 10;

const REVERT_REASONS = {
  timeout: "It wasn't confirmed in time.",
  manual: "You chose to revert it.",
  interrupted: "The host or its timer restarted before it was confirmed.",
  failed_apply: "The Apply failed, and the revert only finished later.",
};

/** The last /apply/session body, or null before the first answer and on an API without it. */
let status = null;
let unreachable = false;
/** When the session's time runs out, on this page's clock: the host's clock may differ. */
let endsAt = 0;
let warned = false;
let busy = false;
let lastSeenSession = false;
let onSettled = async () => {};

const remainingSeconds = () => Math.max(0, Math.ceil((endsAt - performance.now()) / 1000));

function setNote(text, isErr) {
  const note = $("apply-session-note");
  note.textContent = text;
  note.classList.toggle("err", !!isErr);
}

/** What a button's error is about: it goes when this changes. */
function noteSubject(s) {
  if (s && s.session) return s.session.phase + s.session.deadline;
  return (s && s.last_revert && s.last_revert.at) || "";
}

/** Only an active session has a timer: a failed revert stopped it, and nothing else is coming. */
function noAnswerNote() {
  const phase = status && status.session && status.session.phase;
  if (phase === "active") return NO_ANSWER + " If this change locked you out, the host reverts by itself when the time runs out.";
  if (phase === "failed") return NO_ANSWER + " The host has no timer left to revert this, so fix it on the host.";
  return NO_ANSWER;
}

function moveFocusOutOf(panel) {
  if (panel.contains(document.activeElement)) $("main-content").focus({ preventScroll: true });
}

function render() {
  const panel = $("apply-session");
  const session = status && status.session;
  const revert = status && status.last_revert;
  const failed = !!session && session.phase === "failed";
  const active = !!session && session.phase === "active";
  const rollingBack = !!session && session.phase === "rolling_back";

  if (!session && !revert) {
    moveFocusOutOf(panel);
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  panel.classList.toggle("evu-alert--warning", active || rollingBack);
  panel.classList.toggle("evu-alert--danger", failed);
  panel.classList.toggle("evu-alert--info", !session);

  let title = "";
  let detail = "";
  if (active) {
    const left = remainingSeconds();
    title = "Applied. Keep these changes?";
    detail = left > 0 ? "Reverting in " + left + "s" : "Reverting now…";
  } else if (rollingBack) {
    title = "Reverting to the last confirmed config…";
  } else if (failed) {
    title = "The revert failed, so this host may still be running the rejected config.";
    detail = session.failure || "";
  } else {
    title = "Reverted to the last confirmed config.";
    detail = REVERT_REASONS[revert.reason] || "";
    if (revert.config_available) detail += " The rejected config has been kept.";
  }
  $("apply-session-title").textContent = title;
  $("apply-session-detail").textContent = detail;
  $("apply-session-check").hidden = !active;
  $("apply-session-keep").hidden = !active;
  $("apply-session-revert").hidden = !active && !failed;
  $("apply-session-revert").textContent = failed ? "Retry revert" : "Revert now";
  $("apply-session-restore").hidden = !!session || !revert.config_available;
  $("apply-session-dismiss").hidden = !!session;
  const noteIsErr = $("apply-session-note").classList.contains("err");
  // A button's error stays until its session moves on: it says what didn't happen, which this note doesn't.
  if (!busy && active && unreachable && !noteIsErr) {
    setNote("The API isn't answering. If this change locked you out, the host reverts by itself when the time runs out.");
  } else if (!busy && !noteIsErr) {
    setNote("");
  }
}

function tick() {
  const session = status && status.session;
  if (!session || session.phase !== "active") return;
  const left = remainingSeconds();
  if (left <= WARN_AT_SECONDS && !warned) {
    warned = true;
    $("apply-session-status").textContent = "Reverting in " + WARN_AT_SECONDS + " seconds unless you keep these changes.";
  }
  $("apply-session-detail").textContent = left > 0 ? "Reverting in " + left + "s" : "Reverting now…";
}

function adopt(next) {
  const session = next && next.session;
  const hadSession = lastSeenSession;
  const isNew = !!session && session.phase === "active" && (!status || !status.session || status.session.deadline !== session.deadline);
  if (!busy && noteSubject(status) !== noteSubject(next)) setNote("");
  status = next;
  unreachable = false;
  if (session) {
    endsAt = performance.now() + session.remaining_seconds * 1000;
    if (isNew) {
      warned = false;
      $("apply-session-status").textContent = "Applied. Keep these changes? Reverting in " + session.remaining_seconds + " seconds.";
    }
  }
  lastSeenSession = !!session;
  if (!session) $("apply-session-status").textContent = next && next.last_revert ? "Reverted to the last confirmed config." : "";
  render();
  // It ended without this tab doing anything: on a timer, from another tab, or from the CLI.
  if (hadSession && !session) void onSettled();
}

/** Reads the session. Throws on anything but a clear answer; an API without this route gives null. */
async function fetchStatus() {
  try {
    return await api("/v1/apply/session", { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

async function poll() {
  if (busy || !token()) return;
  try {
    adopt(await fetchStatus());
  } catch {
    unreachable = true;
    render();
  }
}

function schedulePoll() {
  setTimeout(async () => {
    await poll();
    schedulePoll();
  }, status && status.session ? POLL_SESSION_MS : POLL_IDLE_MS);
}

/**
 * What the next Apply should do, freshly read, since the setting can change at any time.
 * `confirm` is false only on a clear answer: an unreachable API throws, so the caller stops.
 * A session already running makes it true even with the setting off, because a one-way
 * reload would be refused while the timer is armed.
 */
export async function readApplyMode() {
  const next = await fetchStatus();
  adopt(next);
  if (!next) return { confirm: false, timeoutSeconds: 0, failedRevert: false };
  const session = next.session;
  return {
    confirm: !!next.confirm_enabled || !!session,
    timeoutSeconds: (session && session.timeout_seconds) || next.confirm_timeout_seconds,
    failedRevert: !!session && session.phase !== "active",
  };
}

/** What the last answer said, for painting before an Apply is asked for. */
export function confirmModeKnown() {
  return !!status && (!!status.confirm_enabled || !!status.session);
}

/** Takes the /reload answer, so the countdown shows without waiting for a poll. */
export function adoptAppliedSession(session) {
  if (!session) return;
  adopt({ ...(status || {}), session, last_revert: null });
  $("apply-session-keep").focus();
}

/** Runs a button's action. A refusal usually means the session has moved on, so re-read it. */
async function act(path, done) {
  if (busy) return;
  busy = true;
  setNote("…");
  try {
    await api(path, { method: "POST", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (e) {
    busy = false;
    // Only an HTTP answer has a status: anything else is a request that got no answer.
    setNote(e.status ? String(e.message || e) : noAnswerNote(), true);
    await poll();
    return;
  }
  setNote("");
  setApiStatus(true);
  done();
  moveFocusOutOf($("apply-session"));
  // Settled just below, so the re-read doesn't report it as ending by itself.
  lastSeenSession = false;
  try {
    adopt(await fetchStatus());
  } catch {
    // The host said yes, so this session is over even if the page can't read what's next.
    // Polling brings back anything left to show, such as the revert.
    adopt({ ...status, session: null, last_revert: null });
  }
  busy = false;
  await onSettled();
}

/** @param {{ onSettled: () => Promise<void> }} opts `onSettled` runs when a session ends. */
export function initApplySession(opts) {
  onSettled = opts.onSettled;
  $("apply-session-keep").addEventListener("click", () => void act("/v1/apply/confirm", () => showToast("Changes kept")));
  $("apply-session-revert").addEventListener("click", () => void act("/v1/apply/revert", () => {}));
  $("apply-session-restore").addEventListener(
    "click",
    () => void act("/v1/apply/reverted/restore", () => showToast("The rejected config is back as unapplied changes"))
  );
  $("apply-session-dismiss").addEventListener("click", () => void act("/v1/apply/reverted/dismiss", () => {}));
  setInterval(tick, TICK_MS);
  void poll().finally(schedulePoll);
}
