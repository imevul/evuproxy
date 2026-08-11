import { state, defaultPeerSubnetCidr, contentWidthKey, contentWidthCssValues } from "../core/state.js";
import { $, setApiStatus } from "../core/dom.js";
import { api, getApiBase, headersDownload } from "../core/api.js";
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

export async function refreshSettingsPage() {
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
  if (spl) spl.checked = !!state.lastUIPrefs.metrics_collection_enabled;
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

  $("settings-save-prefs").addEventListener("click", async () => {
    const cidrRaw = ($("peer-subnet-cidr") && $("peer-subnet-cidr").value.trim()) || "";
    const epRaw = ($("settings-wg-endpoint") && $("settings-wg-endpoint").value.trim()) || "";
    const pubIfRaw = ($("settings-public-interface") && $("settings-public-interface").value.trim()) || "";
    const msg = $("settings-prefs-msg");
    if (msg) {
      msg.textContent = "";
      msg.classList.remove("err");
    }
    if (cidrRaw && !parseIPv4CIDR(cidrRaw)) {
      if (msg) {
        msg.textContent = "Invalid IPv4 CIDR (e.g. 10.100.0.0/24).";
        msg.classList.add("err");
      }
      return;
    }
    const pubIfValid = validLinuxIfaceName(pubIfRaw);
    const configSaveRequested = state.settingsPublicInterfaceLoaded !== null || !!pubIfRaw;
    if (configSaveRequested && !pubIfValid) {
      if (msg) {
        msg.textContent = pubIfRaw
          ? "Invalid public interface name (1–15 chars: letters, digits, . _ -)."
          : "Public interface is required.";
        msg.classList.add("err");
      }
      return;
    }
    try {
      const lat = $("settings-metrics-collection");
      const p = await api("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify({
          peer_tunnel_subnet_cidr: cidrRaw,
          wireguard_server_endpoint: epRaw,
          metrics_collection_enabled: !!(lat && lat.checked),
        }),
      });
      state.lastUIPrefs = {
        peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
        wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
        metrics_collection_enabled: !!p.metrics_collection_enabled,
      };
      let statusParts = ["Preferences saved on server."];
      if (configSaveRequested) {
        let cfg = state.lastConfig;
        if (!cfg) cfg = await api("/v1/config");
        const prevPubIf = String((cfg.network && cfg.network.public_interface) || "").trim();
        if (prevPubIf !== pubIfValid) {
          const cfgOut = JSON.parse(JSON.stringify(cfg));
          if (!cfgOut.network) cfgOut.network = {};
          cfgOut.network.public_interface = pubIfValid;
          await api("/v1/config", { method: "PUT", body: JSON.stringify(cfgOut) });
          state.lastConfig = cfgOut;
          state.settingsPublicInterfaceLoaded = pubIfValid;
          statusParts.push("Public interface saved — reload to apply nftables.");
          refreshPendingBadge();
        }
      } else {
        statusParts.push("Public interface not updated (config could not be loaded).");
      }
      if (msg) {
        msg.textContent = statusParts.join(" ");
        if (statusParts.length === 1 && !epRaw) {
          msg.textContent += " Tip: add WireGuard server endpoint (host:port) for client snippets.";
        }
      }
      setApiStatus(true);
      await refreshEndpointHostWarning();
    } catch (e) {
      if (msg) {
        msg.textContent = String(e.message || e);
        msg.classList.add("err");
      }
      setApiStatus(false, String(e.message || e));
    }
  });

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

  const notesSaveBtn = $("config-notes-save");
  if (notesSaveBtn) {
    notesSaveBtn.addEventListener("click", async () => {
      const msg = $("config-notes-msg");
      const body = ($("config-notes-body") && $("config-notes-body").value) || "";
      if (msg) {
        msg.textContent = "";
        msg.classList.remove("err");
      }
      try {
        await api("/v1/config/notes", { method: "PUT", body: JSON.stringify({ text: body }) });
        if (msg) msg.textContent = "Notes saved.";
        setApiStatus(true);
      } catch (e) {
        if (msg) {
          msg.textContent = String(e.message || e);
          msg.classList.add("err");
        }
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
        if (msg) msg.textContent = "Backup created: " + path;
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
        confirmLabel: "Restore",
        onConfirm: async () => {
          closeConfirmModal();
          if (msg) {
            msg.textContent = "";
            msg.classList.remove("err");
          }
          try {
            const q = "?path=" + encodeURIComponent(path);
            await api("/v1/restore" + q, { method: "POST" });
            if (msg) msg.textContent = "Restore finished. Review config and use Reload if needed.";
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
        await api("/v1/config", { method: "PUT", body: JSON.stringify(state.configUploadDraft) });
        state.lastConfig = state.configUploadDraft;
        if (am) am.textContent = "Saved. Check Pending changes / Reload.";
        closeConfigUploadModal();
        const um = $("config-upload-msg");
        if (um) um.textContent = "Config updated on server.";
        refreshPendingBadge();
      } catch (e) {
        if (am) {
          am.textContent = String(e.message || e);
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
