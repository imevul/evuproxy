import { state } from "./state.js";
import { $ } from "./dom.js";

export const apiBaseKey = "evuproxy_api_base";

export function normalizeApiBase(s) {
  s = String(s).trim().replace(/\/+$/, "");
  return s || "/api";
}

function getDefaultApiBase() {
  if (typeof window.EVUPROXY_API === "string" && window.EVUPROXY_API.trim() !== "") {
    return normalizeApiBase(window.EVUPROXY_API);
  }
  return "/api";
}

export function getApiBase() {
  try {
    const saved = sessionStorage.getItem(apiBaseKey) || localStorage.getItem(apiBaseKey);
    if (saved != null && String(saved).trim() !== "") {
      return normalizeApiBase(saved);
    }
  } catch (e) {
    /* ignore */
  }
  return getDefaultApiBase();
}

export const tokenKey = "evuproxy_api_token";

/** The token Connect stored, leaving out anything still being typed into the field. */
export function savedToken() {
  return sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
}

export function token() {
  return savedToken() || ($("token") && $("token").value.trim()) || "";
}

function headers() {
  const t = token();
  const h = { Accept: "application/json", "Content-Type": "application/json" };
  if (t) h["X-API-Token"] = t;
  return h;
}

export function headersDownload() {
  const t = token();
  const h = { Accept: "*/*" };
  if (t) h["X-API-Token"] = t;
  return h;
}

export function applyNavRestriction() {
  const restricted = !state.apiConnectionOk;
  document.querySelectorAll(".nav-link").forEach((a) => {
    const route = a.getAttribute("data-route");
    const allowed = route === "overview" || route === "token";
    const dis = restricted && !allowed;
    a.classList.toggle("nav-disabled", dis);
    if (dis) {
      a.setAttribute("aria-disabled", "true");
      a.setAttribute("tabindex", "-1");
    } else {
      a.removeAttribute("aria-disabled");
      a.removeAttribute("tabindex");
    }
  });
}

/** Returns true when the API is reachable with the current token (also sets state.lastOverview on success). */
export async function ensureApiGate() {
  const t = token().trim();
  if (!t) {
    state.apiConnectionOk = false;
    applyNavRestriction();
    return false;
  }
  try {
    const o = await api("/v1/overview");
    state.lastOverview = o;
    state.apiConnectionOk = true;
    applyNavRestriction();
    return true;
  } catch {
    state.apiConnectionOk = false;
    applyNavRestriction();
    requestConnectionCheck();
    return false;
  }
}

/* Told how each request went: "answered", "unreachable" or "auth". See connection.js. */
let apiObserver = () => {};

export function observeApi(fn) {
  apiObserver = fn;
}

/** For a failure api() can't judge alone, such as a 500 on the request the nav gate depends on. */
export function requestConnectionCheck() {
  apiObserver("check");
}

/** A request that got no answer. Only an HTTP answer has a status, as callers rely on. */
function noAnswerError() {
  const ex = new Error("No answer from the EvuProxy API.");
  ex.connectionKind = "unreachable";
  return ex;
}

/**
 * Sorts a failed answer into "auth", "unreachable" or neither (undefined). A gateway error
 * comes from nginx with the API behind it down. The API's own 503 ("another operation is in
 * progress") is JSON with an error, and means that it's up.
 */
function failureKind(status, body) {
  if (status === 401) return "auth";
  if ([502, 503, 504].includes(status) && !body.error) return "unreachable";
  return undefined;
}

// ETag per parsed response body, so a revision cannot drift from the data it came with.
const responseEtags = new WeakMap();

/** The ETag sent with a body returned by api(), or "" if there was none. */
export function responseEtag(body) {
  return responseEtags.get(body) || "";
}

/** @param {RequestInit & { unobserved?: boolean }} [opts] `unobserved` for the connection probe itself. */
export async function api(path, { unobserved, ...opts } = {}) {
  const report = unobserved ? () => {} : apiObserver;
  let r;
  let text;
  try {
    r = await fetch(getApiBase() + path, {
      ...opts,
      headers: { ...headers(), ...opts.headers },
    });
    text = await r.text();
  } catch (e) {
    if (e.name === "AbortError") throw e;
    report("unreachable");
    throw noAnswerError();
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  if (!r.ok) {
    let err = body.error || body.raw || r.statusText;
    if (typeof err === "string" && err.trimStart().startsWith("<")) {
      if (r.status === 502 || /502|Bad Gateway|504|Gateway Time-?out/i.test(err)) {
        err =
          "Cannot reach EvuProxy on the host (HTTP " +
          r.status +
          "). Start the API: sudo systemctl start evuproxy-api.service — " +
          "the UI proxies /api to 127.0.0.1:9847 (see docker-compose.yml; host network).";
      } else {
        err = "HTTP " + r.status + ": unexpected HTML from server (check nginx/API upstream).";
      }
    }
    const ex = new Error(err);
    ex.status = r.status;
    if (body.error_code) ex.errorCode = body.error_code;
    // Some endpoints put the payload the caller needs behind a non-2xx status —
    // /validate answers 400 with the full result, error list included.
    ex.body = body;
    ex.connectionKind = failureKind(r.status, body);
    report(ex.connectionKind || "answered");
    throw ex;
  }
  report("answered");
  const etag = r.headers.get("ETag");
  if (etag && body && typeof body === "object") responseEtags.set(body, etag);
  return body;
}

export async function apiBlob(path, opts = {}) {
  const r = await fetch(getApiBase() + path, {
    ...opts,
    headers: { ...headers(), ...opts.headers },
  });
  if (!r.ok) {
    const text = await r.text();
    let err = text;
    try {
      const j = JSON.parse(text);
      err = j.error || text;
    } catch {
      /* ignore */
    }
    throw new Error(err);
  }
  return r.blob();
}
