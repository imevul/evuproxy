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
/** Whether the API has answered since the page opened, so that contact can have been lost. */
let everAnswered = false;
/** The pages that have shown API data since the page opened. */
const loadedPages = new Set();
let probing = false;
let probeAgain = false;
let retrying = false;
let retryTimer = null;
let onRecovered = () => {};
let lastReloadAt = 0;
let reloadTimer = null;

function setText(el, text) {
  // The banner is a live region, so unchanged text must not be rewritten.
  if (el.textContent !== text) el.textContent = text;
}

/** A page calls this once it shows API data, so that an outage can call that data stale. */
export function markPageLoaded(name) {
  loadedPages.add(name);
}

function setPageTag(row, className, text, on) {
  const tag = row.querySelector("." + className);
  if (!on) {
    if (tag) tag.remove();
  } else if (!tag) {
    const el = document.createElement("span");
    el.className = "evu-pill " + className;
    el.textContent = text;
    row.appendChild(el);
  }
}

/** Tags every page that shows API data. The API token page has none, and Overview says it in a card. */
function markPages(outage) {
  document.querySelectorAll(".page:not(#page-token)").forEach((page) => {
    const row = page.querySelector(".page-title-row");
    const name = page.id.replace("page-", "");
    const loaded = loadedPages.has(name);
    setPageTag(row, "stale-tag", "Stale data", outage && loaded);
    setPageTag(row, "not-loaded-tag", "Not loaded yet", outage && !loaded && name !== "overview");
  });
}

function pageStateText() {
  const page = document.querySelector(".page:not([hidden])");
  const name = page ? page.id.replace("page-", "") : "";
  if (name === "token") return "";
  return loadedPages.has(name)
    ? "What's on screen was loaded before then and may be out of date. "
    : "This page hasn't loaded yet. It fills in as soon as the API answers. ";
}

/** Also called when the page on screen changes, since the banner speaks about that page. */
export function renderConnectionState() {
  const banner = $("connection-banner");
  if (!lost) {
    if (banner.contains(document.activeElement)) $("main-content").focus({ preventScroll: true });
    banner.hidden = true;
    markPages(false);
    return;
  }
  setText($("connection-banner-title"), TITLES[lost.kind]);
  setText($("connection-banner-detail"), lost.detail);
  setText(
    $("connection-banner-stale"),
    (everAnswered ? "Lost contact at " + lost.since.toLocaleTimeString() + ". " : "") + pageStateText() + "Trying again automatically."
  );
  $("connection-banner-token").hidden = lost.kind !== "auth";
  banner.hidden = false;
  markPages(true);
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
  renderConnectionState();
}

/**
 * Reloads the page on screen, at most once per retry interval. If that reload fails while the
 * probe still succeeds, recovering again must not turn into a tight loop of requests.
 */
function reloadAfterRecovery() {
  clearTimeout(reloadTimer);
  if (lost) return;
  const wait = lastReloadAt + RETRY_MS - Date.now();
  if (wait > 0) {
    reloadTimer = setTimeout(reloadAfterRecovery, wait);
    return;
  }
  lastReloadAt = Date.now();
  onRecovered();
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
  renderConnectionState();
  if (wasLost) showToast("Connection restored");
  // A page that stopped at the nav gate never loaded, even if no banner ever showed.
  if (wasLost || wasRestricted) reloadAfterRecovery();
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
    renderConnectionState();
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
