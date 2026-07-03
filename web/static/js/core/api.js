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

export function token() {
  return sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || ($("token") && $("token").value.trim()) || "";
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
    return false;
  }
}

export async function api(path, opts = {}) {
  const r = await fetch(getApiBase() + path, {
    ...opts,
    headers: { ...headers(), ...opts.headers },
  });
  const text = await r.text();
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
    if (body.error_code) ex.errorCode = body.error_code;
    throw ex;
  }
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
