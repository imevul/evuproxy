import { $ } from "../core/dom.js";
import { tokenKey, apiBaseKey, normalizeApiBase } from "../core/api.js";
import { invalidateUIPrefsCache } from "../core/prefs.js";
import { refreshOverviewPage } from "./overview.js";

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
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initTokenPage() {
  const savedTok = localStorage.getItem(tokenKey);
  if (savedTok && $("token")) $("token").value = savedTok;
  const savedApiBase = localStorage.getItem(apiBaseKey);
  if ($("api-base") && savedApiBase != null && String(savedApiBase).trim() !== "") {
    $("api-base").value = String(savedApiBase).trim();
  }

  $("save-token").addEventListener("click", () => {
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
    setAuthMsg("Saved in browser storage.");
    void refreshOverviewPage();
  });
}
