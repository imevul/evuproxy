import { state } from "../core/state.js";
import { $ } from "../core/dom.js";
import { tokenKey, apiBaseKey, normalizeApiBase } from "../core/api.js";
import { invalidateUIPrefsCache } from "../core/prefs.js";
import { createFormTrackerByIds, registerPageForm } from "../core/dirty.js";
import { refreshOverviewPage } from "./overview.js";

const tokenForm = createFormTrackerByIds(["token", "api-base"]);

function setAuthMsg(text, isErr) {
  const el = $("auth-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function setNotConnectedNotice(visible) {
  const el = $("token-not-connected");
  if (el) el.classList.toggle("is-hidden", !visible);
}

export function refreshTokenPage() {
  const el = $("token");
  const saved = sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
  if (el) el.value = saved;
  setNotConnectedNotice(!saved);
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

  $("save-token").addEventListener("click", async () => {
    const wasConnected = state.apiConnectionOk;
    const t = $("token").value.trim();
    if (t) {
      localStorage.setItem(tokenKey, t);
    }
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
    setAuthMsg("Saved in browser storage.");
    await refreshOverviewPage();
    const hasToken = !!(sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey));
    setNotConnectedNotice(!hasToken);
    if (!hasToken) return;
    if (!state.apiConnectionOk) {
      setAuthMsg("Saved, but the API did not accept it. Check the token and the API base URL.", true);
    } else if (!wasConnected) {
      // First connection: the setup checklist on Overview is the next step.
      location.hash = "#/overview";
    }
  });
}
