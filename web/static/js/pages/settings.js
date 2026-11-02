import { state, defaultPeerSubnetCidr, contentWidthKey, contentWidthCssValues } from "../core/state.js";
import { $, setApiStatus } from "../core/dom.js";
import { beginLoading } from "../core/loading.js";
import { api, getApiBase, headersDownload, responseEtag } from "../core/api.js";
import { showToast, reportBesideControl } from "../core/toast.js";
import { saveConfigEdit, putConfigAtRevision, isConfigRevisionMismatch } from "../core/config_save.js";
import {
  fetchUIPrefsFromServer,
  migrateFromLocalStorageIfEmpty,
  invalidateUIPrefsCache,
} from "../core/prefs.js";
import {
  syncAdvancedSettingsToggle,
  syncAdvancedTabsGating,
  setAdvancedSettingsEnabled,
} from "../core/advanced.js";
import { parseIPv4CIDR, validLinuxIfaceName } from "../core/net.js";
import {
  openModal,
  closeModal,
  openConfirmModal,
  closeConfirmModal,
  registerModalCloser,
} from "../core/modal.js";
import { createFormTrackerByIds } from "../core/dirty.js";
import { createSaveBar } from "../core/save_bar.js";
import { refreshOverviewPage, refreshOverviewEventsList } from "./overview.js";
import { refreshPendingBadge } from "./pending.js";

/* ——— Settings ——— */
function getContentWidthPreset() {
  try {
    const v = localStorage.getItem(contentWidthKey);
    if (v === "small" || v === "medium" || v === "large" || v === "full") return v;
  } catch (e) {
    /* ignore */
  }
  return "medium";
}

function applyContentMaxWidth(preset) {
  const v = contentWidthCssValues[preset] || contentWidthCssValues.medium;
  document.documentElement.style.setProperty("--evuproxy-content-max-width", v);
}

function setContentWidthPreset(preset) {
  if (!Object.prototype.hasOwnProperty.call(contentWidthCssValues, preset)) preset = "medium";
  try {
    localStorage.setItem(contentWidthKey, preset);
  } catch (e) {
    /* ignore */
  }
  applyContentMaxWidth(preset);
  syncContentWidthSelect();
}

async function refreshEndpointHostWarning() {
  const el = $("settings-wg-endpoint-warn");
  if (!el) return;
  el.textContent = "";
  el.classList.add("is-hidden");
  try {
    const o = await api("/v1/overview");
    const warnings = (o && o.host_warnings) || [];
    const hit = warnings.find(
      (w) => w && (w.code === "wg_endpoint_host_mismatch" || w.code === "wg_endpoint_dns_lookup_failed")
    );
    if (hit && (hit.message || hit.Message)) {
      el.textContent = String(hit.message || hit.Message);
      el.classList.remove("is-hidden");
    }
  } catch {
    /* overview optional for settings prefs */
  }
}

function syncContentWidthSelect() {
  const sel = $("settings-content-width");
  if (!sel) return;
  const p = getContentWidthPreset();
  sel.value = Object.prototype.hasOwnProperty.call(contentWidthCssValues, p) ? p : "medium";
}

/*
 * One save bar over three stores, each written only if its fields changed: UI
 * preferences, config and notes. The API has no transaction across them, so a save can
 * land partly. Whatever landed is marked clean as it lands, which leaves the bar up
 * over just the rest, and Save retries only that.
 */
const SETTINGS_PREF_FIELDS = ["peer-subnet-cidr", "settings-wg-endpoint"];
const SETTINGS_CONFIG_FIELDS = ["settings-public-interface"];
const SETTINGS_NOTES_FIELDS = ["config-notes-body"];
/** The fields behind the save bar. The other Settings controls apply as soon as they change. */
const settingsForm = createFormTrackerByIds([
  ...SETTINGS_PREF_FIELDS,
  ...SETTINGS_CONFIG_FIELDS,
  ...SETTINGS_NOTES_FIELDS,
]);
let settingsSaveBar = null;

function adoptUIPrefs(p) {
  state.lastUIPrefs = {
    peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
    wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
    metrics_collection_enabled: !!p.metrics_collection_enabled,
  };
}

/** A write is in flight: a second flip would race it, and could land first. */
let metricsSwitchBusy = false;

/** Instant switch: sends only its own field, so unsaved edits on this page stay unsaved. */
async function setMetricsCollection(on) {
  if (metricsSwitchBusy) return;
  metricsSwitchBusy = true;
  const input = $("settings-metrics-collection");
  const err = $("settings-metrics-collection-msg");
  input.checked = on;
  err.textContent = "";
  try {
    adoptUIPrefs(
      await api("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify({ metrics_collection_enabled: on }),
      })
    );
    metricsSwitchBusy = false;
    input.checked = state.lastUIPrefs.metrics_collection_enabled;
    setApiStatus(true);
    showToast("Peer ICMP metrics " + (on ? "enabled" : "disabled"), {
      action: { label: "Undo", onClick: () => void setMetricsCollection(!on) },
    });
  } catch (e) {
    metricsSwitchBusy = false;
    input.checked = !on;
    reportBesideControl(err, String(e.message || e));
  }
}

/** Save bar action. Validates everything before writing anything. */
async function saveSettingsForm() {
  const cidrRaw = $("peer-subnet-cidr").value.trim();
  const epRaw = $("settings-wg-endpoint").value.trim();
  const pubIfRaw = $("settings-public-interface").value.trim();
  const body = $("config-notes-body").value;
  const prefsDirty = settingsForm.isDirty(SETTINGS_PREF_FIELDS);
  const configDirty = settingsForm.isDirty(SETTINGS_CONFIG_FIELDS);
  const notesDirty = settingsForm.isDirty(SETTINGS_NOTES_FIELDS);
  // What each store is sent. The form stays editable during the requests, and a later edit is still unsaved.
  const sent = settingsForm.values();
  if (cidrRaw && !parseIPv4CIDR(cidrRaw)) throw new Error("Invalid IPv4 CIDR (e.g. 10.100.0.0/24).");
  const pubIfValid = validLinuxIfaceName(pubIfRaw);
  if (configDirty && !pubIfValid) {
    throw new Error(
      pubIfRaw ? "Invalid public interface name (1–15 chars: letters, digits, . _ -)." : "Public interface is required."
    );
  }

  const saved = [];
  const failed = [];
  if (prefsDirty) {
    try {
      adoptUIPrefs(
        await api("/v1/preferences", {
          method: "PUT",
          body: JSON.stringify({ peer_tunnel_subnet_cidr: cidrRaw, wireguard_server_endpoint: epRaw }),
        })
      );
      settingsForm.mark(SETTINGS_PREF_FIELDS, sent);
      saved.push("Preferences");
      void refreshEndpointHostWarning();
    } catch (e) {
      failed.push("Preferences: " + String(e.message || e));
    }
  }
  if (configDirty) {
    try {
      await saveConfigEdit((cfg) => {
        if (!cfg.network) cfg.network = {};
        cfg.network.public_interface = pubIfValid;
      });
      state.settingsPublicInterfaceLoaded = pubIfValid;
      settingsForm.mark(SETTINGS_CONFIG_FIELDS, sent);
      saved.push("Public interface");
      refreshPendingBadge();
    } catch (e) {
      failed.push("Public interface: " + String(e.message || e));
    }
  }
  if (notesDirty) {
    try {
      await api("/v1/config/notes", { method: "PUT", body: JSON.stringify({ text: body }) });
      settingsForm.mark(SETTINGS_NOTES_FIELDS, sent);
      saved.push("Notes");
    } catch (e) {
      failed.push("Notes: " + String(e.message || e));
    }
  }

  if (failed.length) {
    const landed = saved.length ? " Already saved: " + saved.join(", ") + "." : "";
    throw new Error("Not saved. " + failed.join(" ") + landed);
  }
  const msg = $("settings-prefs-msg");
  msg.textContent = epRaw ? "" : "Tip: add WireGuard server endpoint (host:port) for client snippets.";
  msg.classList.remove("err");
  setApiStatus(true);
  showToast(
    configDirty
      ? "Settings saved. The public interface needs Apply: review it on Pending changes."
      : "Settings saved"
  );
}

export async function refreshSettingsPage() {
  const doneLoading = beginLoading("settings-tab-prefs-panel", "settings-tab-maint-panel");
  try {
    await loadSettingsPage();
  } finally {
    doneLoading();
  }
}

async function loadSettingsPage() {
  const msg = $("settings-prefs-msg");
  if (msg) {
    msg.textContent = "";
    msg.classList.remove("err");
  }
  try {
    await fetchUIPrefsFromServer();
    state.uiPrefsFetched = true;
    setApiStatus(true);
  } catch (e) {
    if (msg) {
      msg.textContent = String(e.message || e);
      msg.classList.add("err");
    }
    setApiStatus(false, String(e.message || e));
    state.lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "", metrics_collection_enabled: false };
    migrateFromLocalStorageIfEmpty();
  }
  const cidr = $("peer-subnet-cidr");
  if (cidr) cidr.value = (state.lastUIPrefs.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr;
  const sep = $("settings-wg-endpoint");
  if (sep) sep.value = (state.lastUIPrefs.wireguard_server_endpoint || "").trim();
  const spl = $("settings-metrics-collection");
  if (spl && !metricsSwitchBusy) spl.checked = !!state.lastUIPrefs.metrics_collection_enabled;
  const pubIfEl = $("settings-public-interface");
  if (pubIfEl) {
    try {
      const cfg = await api("/v1/config");
      if (cfg) {
        state.lastConfig = cfg;
        state.settingsPublicInterfaceLoaded = String((cfg.network && cfg.network.public_interface) || "").trim();
        pubIfEl.value = state.settingsPublicInterfaceLoaded;
        pubIfEl.placeholder = "eth0";
      }
    } catch (e) {
      state.settingsPublicInterfaceLoaded = null;
      pubIfEl.value = "";
      pubIfEl.placeholder = "Load failed — refresh Settings";
      if (msg) {
        msg.textContent = String(e.message || e);
        msg.classList.add("err");
      }
    }
  }
  await refreshEndpointHostWarning();
  syncAdvancedSettingsToggle();
  syncAdvancedTabsGating();
  syncContentWidthSelect();
  const notesEl = $("config-notes-body");
  const notesMsg = $("config-notes-msg");
  if (notesEl) {
    if (notesMsg) {
      notesMsg.textContent = "";
      notesMsg.classList.remove("err");
    }
    try {
      const n = await api("/v1/config/notes");
      notesEl.value = (n.text != null && n.text !== undefined) ? String(n.text) : "";
    } catch (e) {
      if (notesMsg) {
        notesMsg.textContent = String(e.message || e);
        notesMsg.classList.add("err");
      }
      notesEl.value = "";
    }
  }
  const bp = $("backup-path-input");
  const rp = $("restore-path-input");
  if (bp && !bp.value.trim()) bp.value = "/var/backups/evuproxy-config.tgz";
  if (rp && !rp.value.trim()) rp.value = "/var/backups/evuproxy-config.tgz";
  settingsForm.mark();
  if (settingsSaveBar) settingsSaveBar.sync();
}

export function setSettingsEditorTab(which) {
  const prefs = which === "prefs";
  const maint = which === "maint";
  const adv = which === "adv";
  const prefsBtn = $("settings-tab-prefs-btn");
  const maintBtn = $("settings-tab-maint-btn");
  const advBtn = $("settings-tab-adv-btn");
  const prefsPanel = $("settings-tab-prefs-panel");
  const maintPanel = $("settings-tab-maint-panel");
  const advPanel = $("settings-tab-adv-panel");
  if (!prefsBtn || !maintBtn || !advBtn || !prefsPanel || !maintPanel || !advPanel) return;
  prefsBtn.classList.toggle("is-active", prefs);
  maintBtn.classList.toggle("is-active", maint);
  advBtn.classList.toggle("is-active", adv);
  prefsBtn.setAttribute("aria-selected", prefs ? "true" : "false");
  maintBtn.setAttribute("aria-selected", maint ? "true" : "false");
  advBtn.setAttribute("aria-selected", adv ? "true" : "false");
  prefsPanel.hidden = !prefs;
  maintPanel.hidden = !maint;
  advPanel.hidden = !adv;
}

function stableSortKeys(x) {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(stableSortKeys);
  const o = {};
  for (const k of Object.keys(x).sort()) {
    o[k] = stableSortKeys(x[k]);
  }
  return o;
}

function stableConfigJson(cfg) {
  return JSON.stringify(cfg == null ? null : stableSortKeys(cfg));
}

function openConfigUploadModal() {
  const m = $("config-upload-modal");
  if (m) openModal(m);
}

function closeConfigUploadModal() {
  state.configUploadDraft = null;
  const m = $("config-upload-modal");
  if (m) closeModal(m);
  const am = $("config-upload-apply-msg");
  if (am) {
    am.textContent = "";
    am.classList.remove("err");
  }
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initSettingsPage() {
  settingsSaveBar = createSaveBar("settings", {
    isDirty: () => settingsForm.isDirty(),
    clear: () => settingsForm.clear(),
    save: saveSettingsForm,
    discard: () => settingsForm.revert(),
  });
  const metricsToggle = $("settings-metrics-collection");
  if (metricsToggle) {
    metricsToggle.addEventListener("change", () => {
      if (metricsSwitchBusy) metricsToggle.checked = !metricsToggle.checked;
      else void setMetricsCollection(metricsToggle.checked);
    });
  }
  registerModalCloser($("config-upload-modal"), closeConfigUploadModal);
  const settingsTabPrefs = $("settings-tab-prefs-btn");
  const settingsTabMaint = $("settings-tab-maint-btn");
  const settingsTabAdv = $("settings-tab-adv-btn");
  if (settingsTabPrefs) settingsTabPrefs.addEventListener("click", () => setSettingsEditorTab("prefs"));
  if (settingsTabMaint) settingsTabMaint.addEventListener("click", () => setSettingsEditorTab("maint"));
  if (settingsTabAdv) settingsTabAdv.addEventListener("click", () => setSettingsEditorTab("adv"));

  const advToggle = $("settings-advanced-toggle");
  if (advToggle) {
    advToggle.addEventListener("change", () => setAdvancedSettingsEnabled(advToggle.checked));
  }
  syncAdvancedSettingsToggle();
  syncAdvancedTabsGating();

  applyContentMaxWidth(getContentWidthPreset());
  const contentWidthSel = $("settings-content-width");
  if (contentWidthSel) {
    contentWidthSel.addEventListener("change", () => setContentWidthPreset(contentWidthSel.value));
  }
  syncContentWidthSelect();

  const dlYaml = $("settings-download-yaml");
  if (dlYaml) {
    dlYaml.addEventListener("click", async () => {
      const msg = $("settings-prefs-msg");
      if (msg) {
        msg.textContent = "";
        msg.classList.remove("err");
      }
      try {
        const r = await fetch(getApiBase() + "/v1/config.yaml", { headers: headersDownload() });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(t || r.statusText);
        }
        const blob = await r.blob();
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "config.yaml";
        a.click();
        URL.revokeObjectURL(a.href);
        if (msg) msg.textContent = "Download started.";
      } catch (e) {
        if (msg) {
          msg.textContent = String(e.message || e);
          msg.classList.add("err");
        }
      }
    });
  }

  $("btn-status").addEventListener("click", async () => {
    const out = $("settings-status-out");
    out.textContent = "…";
    try {
      const j = await api("/v1/status");
      out.textContent = j.report || JSON.stringify(j, null, 2);
      setApiStatus(true);
    } catch (e) {
      out.textContent = String(e.message || e);
      setApiStatus(false, String(e.message || e));
    }
  });

  const dlDiag = $("btn-diagnostics-download");
  if (dlDiag) {
    dlDiag.addEventListener("click", async () => {
      const msg = $("settings-diagnostics-msg");
      if (msg) {
        msg.textContent = "";
        msg.classList.remove("err");
      }
      try {
        const r = await fetch(getApiBase() + "/v1/diagnostics.md", { headers: headersDownload() });
        if (!r.ok) {
          let err = r.statusText;
          try {
            const j = await r.json();
            err = j.error || err;
          } catch {
            /* ignore */
          }
          throw new Error(err || "HTTP " + r.status);
        }
        const blob = await r.blob();
        let filename = "evuproxy-diagnostics.md";
        const cd = r.headers.get("Content-Disposition") || "";
        const m = /filename="([^"]+)"/i.exec(cd);
        if (m && m[1]) filename = m[1];
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        URL.revokeObjectURL(a.href);
        if (msg) msg.textContent = "Download started (" + filename + ").";
        setApiStatus(true);
      } catch (e) {
        if (msg) {
          msg.textContent = String(e.message || e);
          msg.classList.add("err");
        }
        setApiStatus(false, String(e.message || e));
      }
    });
  }

  const backupBtn = $("btn-backup-run");
  if (backupBtn) {
    backupBtn.addEventListener("click", async () => {
      const msg = $("backup-restore-msg");
      if (msg) {
        msg.textContent = "";
        msg.classList.remove("err");
      }
      let path = (($("backup-path-input") && $("backup-path-input").value) || "").trim();
      if (!path) path = "/var/backups/evuproxy-config.tgz";
      try {
        const q = "?path=" + encodeURIComponent(path);
        await api("/v1/backup" + q, { method: "POST" });
        showToast("Backup created: " + path);
        setApiStatus(true);
        void refreshOverviewEventsList();
      } catch (e) {
        if (msg) {
          msg.textContent = String(e.message || e);
          msg.classList.add("err");
        }
      }
    });
  }

  const restoreBtn = $("btn-restore-run");
  if (restoreBtn) {
    restoreBtn.addEventListener("click", () => {
      const path = (($("restore-path-input") && $("restore-path-input").value) || "").trim();
      const msg = $("backup-restore-msg");
      if (!path) {
        if (msg) {
          msg.textContent = "Set restore path (absolute, under the backup allow directory).";
          msg.classList.add("err");
        }
        return;
      }
      openConfirmModal({
        title: "Restore from backup?",
        message:
          "This replaces files under /etc/evuproxy from the archive. Reload the host if needed. Path: " + path,
        confirmLabel: "Replace host files",
        onConfirm: async () => {
          closeConfirmModal();
          if (msg) {
            msg.textContent = "";
            msg.classList.remove("err");
          }
          try {
            const q = "?path=" + encodeURIComponent(path);
            await api("/v1/restore" + q, { method: "POST" });
            showToast("Restore finished. Review config and use Reload if needed.");
            setApiStatus(true);
            invalidateUIPrefsCache();
            state.lastConfig = await api("/v1/config");
            void refreshOverviewPage();
            void refreshOverviewEventsList();
            refreshPendingBadge();
          } catch (e) {
            if (msg) {
              msg.textContent = String(e.message || e);
              msg.classList.add("err");
            }
          }
        },
      });
    });
  }

  const configUploadOpen = $("config-upload-open");
  const configUploadFile = $("config-upload-file");
  // Revision of the "current" pane in the upload preview: Save replaces exactly what was shown.
  let configUploadRevision = "";
  if (configUploadOpen && configUploadFile) {
    configUploadOpen.addEventListener("click", () => configUploadFile.click());
    configUploadFile.addEventListener("change", () => {
      const f = configUploadFile.files && configUploadFile.files[0];
      configUploadFile.value = "";
      if (!f) return;
      const r = new FileReader();
      r.onload = async () => {
        const txt = String(r.result || "");
        let parsed;
        try {
          parsed = JSON.parse(txt);
        } catch (e) {
          const mu = $("config-upload-msg");
          if (mu) {
            mu.textContent = "Invalid JSON: " + String(e.message || e);
            mu.classList.add("err");
          }
          return;
        }
        if (!parsed || typeof parsed !== "object") {
          const mu = $("config-upload-msg");
          if (mu) {
            mu.textContent = "JSON must be an object.";
            mu.classList.add("err");
          }
          return;
        }
        let cur;
        try {
          cur = await api("/v1/config");
        } catch (e) {
          const mu = $("config-upload-msg");
          if (mu) {
            mu.textContent = String(e.message || e);
            mu.classList.add("err");
          }
          return;
        }
        state.configUploadDraft = parsed;
        configUploadRevision = responseEtag(cur);
        const hint = $("config-upload-modal-hint");
        const same = stableConfigJson(cur) === stableConfigJson(parsed);
        if (hint) {
          hint.textContent = same
            ? "Uploaded JSON matches server config."
            : "Preview below — Save replaces the server file (YAML comments are not preserved).";
        }
        const preC = $("config-upload-pre-current");
        const preN = $("config-upload-pre-new");
        if (preC) preC.textContent = JSON.stringify(cur, null, 2);
        if (preN) preN.textContent = JSON.stringify(parsed, null, 2);
        const um = $("config-upload-msg");
        if (um) {
          um.textContent = "";
          um.classList.remove("err");
        }
        openConfigUploadModal();
      };
      r.readAsText(f);
    });
  }

  const configUploadApply = $("config-upload-apply");
  if (configUploadApply) {
    configUploadApply.addEventListener("click", async () => {
      const am = $("config-upload-apply-msg");
      if (!state.configUploadDraft) {
        if (am) {
          am.textContent = "No file loaded.";
          am.classList.add("err");
        }
        return;
      }
      if (am) {
        am.textContent = "";
        am.classList.remove("err");
      }
      try {
        await putConfigAtRevision(state.configUploadDraft, configUploadRevision);
        closeConfigUploadModal();
        refreshPendingBadge();
        showToast("Config replaced on server. Check Pending changes / Reload.");
      } catch (e) {
        let text = String(e.message || e);
        if (isConfigRevisionMismatch(e)) {
          // An upload replaces everything, so there is no edit to reapply: show what is there now and let the user decide.
          try {
            const cur = await api("/v1/config");
            state.lastConfig = cur;
            configUploadRevision = responseEtag(cur);
            const preC = $("config-upload-pre-current");
            if (preC) preC.textContent = JSON.stringify(cur, null, 2);
            text = "The server config changed since this preview, so nothing was saved. The current config above is updated: Save again to replace it.";
          } catch (e2) {
            text = String(e2.message || e2);
          }
        }
        if (am) {
          am.textContent = text;
          am.classList.add("err");
        }
      }
    });
  }
  const configUploadCancel = $("config-upload-cancel");
  if (configUploadCancel) configUploadCancel.addEventListener("click", closeConfigUploadModal);
  const configUploadBd = document.querySelector("#config-upload-modal .modal-backdrop");
  if (configUploadBd) configUploadBd.addEventListener("click", closeConfigUploadModal);
}
