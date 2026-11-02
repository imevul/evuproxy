import { state } from "./state.js";
import { $, setApiStatus } from "./dom.js";
import { api, applyNavRestriction, observeApi, savedToken } from "./api.js";
import { showToast } from "./toast.js";

/*
 * Whether this page can talk to the API, and the banner that says so when it can't.
 *
 * One request failing doesn't say much: a single endpoint can be broken while the rest
 * work. So every answer here only prompts a probe of /v1/overview, the request the nav
 * gate depends on too, and only the probe changes the state. That also keeps a slow
 * answer from before an outage, or from before a new token, from flipping the banner.
 */

const RETRY_MS = 5000;
/* A firewall can drop a request without an answer, and the browser then waits for minutes. */
const PROBE_TIMEOUT_MS = 10000;

const TITLES = {
  unreachable: "Can't reach the EvuProxy API",
  auth: "The API rejected this browser's token",
  error: "The API is returning errors",
};

/** @type {{ kind: string, detail: string, since: Date } | null} null while the API answers. */
let lost = null;
/** Whether anything has loaded since the page opened, so that there can be stale data at all. */
let everAnswered = false;
let probing = false;
let probeAgain = false;
let retrying = false;
let retryTimer = null;
let onRecovered = () => {};

function setText(el, text) {
  // The banner is a live region, so unchanged text must not be rewritten.
  if (el.textContent !== text) el.textContent = text;
}

/** Tags every page that shows API data. The API token page has none. */
function markStale(stale) {
  document.querySelectorAll(".page:not(#page-token) .page-title-row").forEach((row) => {
    const tag = row.querySelector(".stale-tag");
    if (!stale) {
      if (tag) tag.remove();
    } else if (!tag) {
      const el = document.createElement("span");
      el.className = "evu-pill stale-tag";
      el.textContent = "Stale data";
      row.appendChild(el);
    }
  });
}

function render() {
  const banner = $("connection-banner");
  if (!lost) {
    if (banner.contains(document.activeElement)) $("main-content").focus({ preventScroll: true });
    banner.hidden = true;
    markStale(false);
    return;
  }
  setText($("connection-banner-title"), TITLES[lost.kind]);
  setText($("connection-banner-detail"), lost.detail);
  setText(
    $("connection-banner-stale"),
    (everAnswered
      ? "Lost contact at " + lost.since.toLocaleTimeString() + ". What's on screen was loaded before then and may be out of date. "
      : "") + "Trying again automatically."
  );
  $("connection-banner-token").hidden = lost.kind !== "auth";
  banner.hidden = false;
  markStale(everAnswered);
}

function detailFor(kind, e) {
  if (kind === "auth") return "The token is wrong or missing. Enter the right one on the API token page.";
  return String(e.message || e);
}

function markLost(e) {
  const kind = e.connectionKind || "error";
  const detail = detailFor(kind, e);
  lost = { kind, detail, since: lost ? lost.since : new Date() };
  state.apiConnectionOk = false;
  applyNavRestriction();
  setApiStatus(false, detail);
  render();
}

function markAnswering() {
  const wasLost = !!lost;
  const wasRestricted = !state.apiConnectionOk;
  lost = null;
  everAnswered = true;
  setText($("connection-banner-note"), "");
  state.apiConnectionOk = true;
  applyNavRestriction();
  setApiStatus(true);
  render();
  if (wasLost) showToast("Connection restored");
  // A page that stopped at the nav gate never loaded, even if no banner ever showed.
  if (wasLost || wasRestricted) onRecovered();
}

function scheduleProbe() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    // A background tab has nobody to tell. Coming back to it probes at once.
    if (document.hidden) scheduleProbe();
    else void probe();
  }, RETRY_MS);
}

function finishRetry() {
  if (!retrying) return;
  retrying = false;
  $("connection-banner-retry").removeAttribute("aria-busy");
  if (lost) setText($("connection-banner-note"), "Still no answer at " + new Date().toLocaleTimeString() + ".");
}

async function probe() {
  if (probing) {
    probeAgain = true;
    return;
  }
  clearTimeout(retryTimer);
  if (!savedToken()) {
    lost = null;
    render();
    finishRetry();
    return;
  }
  probing = true;
  let failure = null;
  try {
    state.lastOverview = await api("/v1/overview", { unobserved: true, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
  } catch (e) {
    failure = e;
  }
  probing = false;
  // Something changed while this was out, such as a new token, so this answer is old news.
  if (probeAgain) {
    probeAgain = false;
    void probe();
    return;
  }
  if (failure) markLost(failure);
  else markAnswering();
  finishRetry();
  if (lost) scheduleProbe();
}

function onApiOutcome(outcome) {
  if (!savedToken()) return;
  const answered = outcome === "answered";
  if (answered) everAnswered = true;
  if (outcome === "check" || (lost ? answered : !answered)) void probe();
}

/** @param {{ onRecovered: () => void }} opts `onRecovered` brings the page on screen up to date. */
export function initConnection(opts) {
  onRecovered = opts.onRecovered;
  observeApi(onApiOutcome);
  $("connection-banner-retry").addEventListener("click", () => {
    if (retrying) return;
    retrying = true;
    $("connection-banner-retry").setAttribute("aria-busy", "true");
    void probe();
  });
  const probeIfLost = () => {
    if (lost && !document.hidden) void probe();
  };
  document.addEventListener("visibilitychange", probeIfLost);
  window.addEventListener("online", probeIfLost);
}
