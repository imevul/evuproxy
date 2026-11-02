import { state } from "../core/state.js";
import { $, setApiStatus } from "../core/dom.js";
import { api, applyNavRestriction, tokenKey, apiBaseKey, normalizeApiBase } from "../core/api.js";
import { invalidateUIPrefsCache } from "../core/prefs.js";
import { createFormTrackerByIds, registerPageForm } from "../core/dirty.js";
import { refreshOverviewPage } from "./overview.js";

const tokenForm = createFormTrackerByIds(["token", "api-base"]);

function setAuthMsg(text, isErr) {
  const el = $("auth-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

export function refreshTokenPage() {
  const el = $("token");
  if (el) el.value = sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
  const ab = $("api-base");
  if (ab) {
    const saved = sessionStorage.getItem(apiBaseKey) || localStorage.getItem(apiBaseKey);
    ab.value = saved != null && String(saved).trim() !== "" ? String(saved).trim() : "";
  }
  tokenForm.mark();
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initTokenPage() {
  registerPageForm("token", tokenForm);
  const savedTok = localStorage.getItem(tokenKey);
  if (savedTok && $("token")) $("token").value = savedTok;
  const savedApiBase = localStorage.getItem(apiBaseKey);
  if ($("api-base") && savedApiBase != null && String(savedApiBase).trim() !== "") {
    $("api-base").value = String(savedApiBase).trim();
  }

  $("token-connect").addEventListener("click", async () => {
    const t = $("token").value.trim();
    if (!t) {
      setAuthMsg("Enter an API token to connect.", true);
      $("token").focus();
      return;
    }
    localStorage.setItem(tokenKey, t);
    const ab = $("api-base");
    if (ab) {
      const b = ab.value.trim();
      if (b) {
        localStorage.setItem(apiBaseKey, normalizeApiBase(b));
      } else {
        localStorage.removeItem(apiBaseKey);
        try {
          sessionStorage.removeItem(apiBaseKey);
        } catch (e) {
          /* ignore */
        }
      }
    }
    invalidateUIPrefsCache();
    tokenForm.mark();
    setAuthMsg("Connecting…");
    try {
      state.lastOverview = await api("/v1/overview");
      state.apiConnectionOk = true;
      setApiStatus(true);
      setAuthMsg("Connected. The token is saved in this browser.");
    } catch (e) {
      state.apiConnectionOk = false;
      setApiStatus(false, String(e.message || e));
      setAuthMsg("Could not connect: " + String(e.message || e), true);
    }
    applyNavRestriction();
    void refreshOverviewPage();
  });
}
