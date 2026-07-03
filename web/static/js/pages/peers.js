import { state, defaultPeerSubnetCidr } from "../core/state.js";
import {
  $,
  escapeHtml,
  trunc,
  setApiStatus,
  tableDisabledToggleCell,
  monoIpCopyCellHtml,
  bindTunnelIpCopyButtons,
  applyPeersRoutesTableFilter,
  downloadTextFile,
} from "../core/dom.js";
import { api, apiBlob } from "../core/api.js";
import { tunnelToHost, tunnelHostOnly, parseIPv4CIDR, ipv4ToInt, intToIpv4, ipInCidr } from "../core/net.js";
import {
  PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC,
  showPeersMetricsColumn,
  fetchPeerMetricsMap,
  wgPeerPubKeyMap,
} from "../core/peers_data.js";
import { openModal, closeModal, openConfirmModal } from "../core/modal.js";
import { refreshPendingBadge } from "./pending.js";

function serverEndpointDisplay() {
  return (state.lastUIPrefs.wireguard_server_endpoint || "").trim();
}

function peerSubnetCidr() {
  const v = (state.lastUIPrefs.peer_tunnel_subnet_cidr || "").trim();
  if (v && parseIPv4CIDR(v)) return v;
  return defaultPeerSubnetCidr;
}

function suggestedPeerTunnelIP(cfg) {
  const parsed = parseIPv4CIDR(peerSubnetCidr());
  if (!parsed || parsed.prefix >= 31) return "";
  const used = new Set();
  if (cfg && cfg.wireguard && cfg.wireguard.address) {
    const base = String(cfg.wireguard.address).split("/")[0];
    const hi = ipv4ToInt(base);
    if (hi !== null && ipInCidr(hi, parsed)) used.add(hi);
  }
  if (cfg && cfg.peers) {
    for (const p of cfg.peers) {
      if (!p.tunnel_ip) continue;
      const host = tunnelToHost(p.tunnel_ip);
      const hi = ipv4ToInt(host);
      if (hi !== null && ipInCidr(hi, parsed)) used.add(hi);
    }
  }
  if (cfg && cfg.forwarding && cfg.forwarding.routes) {
    for (const r of cfg.forwarding.routes) {
      if (!r.target_ip) continue;
      const hi = ipv4ToInt(String(r.target_ip).trim());
      if (hi !== null && ipInCidr(hi, parsed)) used.add(hi);
    }
  }
  for (let ip = parsed.network + 1; ip < parsed.broadcast; ip++) {
    if (!used.has(ip)) return intToIpv4(ip) + "/32";
  }
  return "";
}

/* ——— Peers ——— */
function setPeersMsg(text, isErr) {
  const el = $("peers-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

export function stopPeersPingPolling() {
  if (state.peersPingTimer) {
    clearInterval(state.peersPingTimer);
    state.peersPingTimer = null;
  }
}

function peerPingMsCell(peer, pingByTunnel) {
  if (!showPeersMetricsColumn()) return "";
  if (peer.disabled) {
    return '<td class="mono peer-ping-cell" title="Peer disabled">—</td>';
  }
  if (!pingByTunnel) {
    return '<td class="mono peer-ping-cell">…</td>';
  }
  const th = tunnelHostOnly(peer.tunnel_ip);
  const row = th ? pingByTunnel.get(th) : null;
  if (!row) return '<td class="mono peer-ping-cell">—</td>';
  if (row.ok) {
    return '<td class="mono peer-ping-cell">' + escapeHtml(String(row.latency_ms)) + " ms</td>";
  }
  const err = row.error ? String(row.error) : "unreachable";
  return '<td class="mono peer-ping-cell" title="' + escapeHtml(err) + '">—</td>';
}

function peerConnectionStatusHtml(p, pubMap) {
  if (p.disabled) {
    return '<span class="peer-status peer-status-na" title="Peer disabled in config">—</span>';
  }
  const pk = String(p.public_key || "").trim();
  const row = pubMap.get(pk);
  if (!row) {
    return (
      '<span class="peer-status peer-status-unknown" title="No WireGuard stats for this key (interface down or mock)">Unknown</span>'
    );
  }
  const h = row.latest_handshake_unix;
  if (!h || h <= 0) {
    return '<span class="peer-status peer-status-off" title="No handshake yet">Offline</span>';
  }
  const ago = Math.floor(Date.now() / 1000) - h;
  let title = "Last handshake ";
  if (ago < 60) title += ago + "s ago";
  else if (ago < 3600) title += Math.floor(ago / 60) + " min ago";
  else title += Math.floor(ago / 3600) + " h ago";
  if (ago <= PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC) {
    return (
      '<span class="peer-status peer-status-on" title="' +
      escapeHtml(title) +
      '">Online</span>'
    );
  }
  return '<span class="peer-status peer-status-off" title="' + escapeHtml(title) + '">Offline</span>';
}

function renderPeersTable(cfg, wgStats, pingByTunnel) {
  if (wgStats === undefined) wgStats = state.lastPeerWgStats;
  if (pingByTunnel === undefined) pingByTunnel = state.lastPeerPingByTunnel;
  const wrap = $("peers-table-wrap");
  if (!cfg.peers || !cfg.peers.length) {
    wrap.innerHTML =
      "<div class=\"empty-state\"><span class=\"empty-state-msg\">No peers configured.</span> <button type=\"button\" class=\"btn-primary\" id=\"peers-empty-add\">Add peer</button></div>";
    const addBtn = $("peers-empty-add");
    if (addBtn) {
      addBtn.addEventListener("click", () => {
        const st = $("peers-add-start");
        if (st) st.click();
      });
    }
    return;
  }
  const wgWarn =
    wgStats && wgStats.wireguard_dump_failed
      ? '<p class="hint">WireGuard peer status unavailable (<code>wg show</code> failed — interface down or tools missing).</p>'
      : "";
  const pubMap = wgPeerPubKeyMap(wgStats);
  const pingOn = showPeersMetricsColumn();
  const pingHead = pingOn ? "<th>Ping</th>" : "";
  const rows = cfg.peers
    .map((p, i) => {
      const f = [p.name, p.tunnel_ip, p.public_key].join(" ").toLowerCase();
      const pingCell = peerPingMsCell(p, pingByTunnel);
      return (
        `<tr data-filter="${escapeHtml(f)}"><td>${escapeHtml(p.name)}</td>` +
        monoIpCopyCellHtml(p.tunnel_ip) +
        `<td class="mono">${escapeHtml(trunc(p.public_key, 20))}</td>${pingCell}<td>${peerConnectionStatusHtml(p, pubMap)}</td>${tableDisabledToggleCell("data-peer-disabled", i, !!p.disabled, "Enabled: " + String(p.name || "peer"))}<td class="row-actions"><button type="button" data-peer-edit="${i}">Edit</button> <button type="button" data-peer-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      );
    })
    .join("");
  wrap.innerHTML = `${wgWarn}<table class="data"><thead><tr><th>Name</th><th>Tunnel IP</th><th>Public key</th>${pingHead}<th>Status</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  bindTunnelIpCopyButtons(wrap, setPeersMsg);
  wrap.querySelectorAll("[data-peer-edit]").forEach((b) => {
    b.addEventListener("click", () => openPeerEditor(+b.getAttribute("data-peer-edit")));
  });
  wrap.querySelectorAll("[data-peer-del]").forEach((b) => {
    b.addEventListener("click", () => removePeer(+b.getAttribute("data-peer-del")));
  });
  wrap.querySelectorAll("input[data-peer-disabled]").forEach((inp) => {
    inp.addEventListener("click", (ev) => ev.stopPropagation());
    inp.addEventListener("change", async () => {
      const idx = +inp.getAttribute("data-peer-disabled");
      await patchPeerDisabled(idx, !inp.checked);
    });
  });
  applyPeersRoutesTableFilter();
}

async function patchPeerDisabled(index, disabled) {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.peers || cfg.peers[index] === undefined) return;
  cfg.peers[index].disabled = disabled;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setPeersMsg("");
    setApiStatus(true);
    refreshPendingBadge();
    renderPeersTable(cfg, state.lastPeerWgStats);
  } catch (e) {
    setPeersMsg(String(e.message || e), true);
    renderPeersTable(state.lastConfig, state.lastPeerWgStats);
  }
}

export async function refreshPeersPage() {
  setPeersMsg("");
  stopPeersPingPolling();
  try {
    const [cfgOut, stOut] = await Promise.allSettled([api("/v1/config"), api("/v1/stats")]);
    if (cfgOut.status !== "fulfilled") {
      throw cfgOut.reason;
    }
    state.lastConfig = cfgOut.value;
    state.lastPeerWgStats = stOut.status === "fulfilled" ? stOut.value : null;
    setApiStatus(true);
    let pingMap = null;
    if (showPeersMetricsColumn()) {
      try {
        pingMap = await fetchPeerMetricsMap();
        state.lastPeerPingByTunnel = pingMap;
      } catch {
        state.lastPeerPingByTunnel = null;
      }
    } else {
      state.lastPeerPingByTunnel = null;
    }
    renderPeersTable(state.lastConfig, state.lastPeerWgStats, pingMap !== null ? pingMap : state.lastPeerPingByTunnel);
    if (showPeersMetricsColumn()) {
      state.peersPingTimer = setInterval(async () => {
        try {
          const m = await fetchPeerMetricsMap();
          state.lastPeerPingByTunnel = m;
          if (state.lastConfig) renderPeersTable(state.lastConfig, state.lastPeerWgStats, m);
        } catch {
          /* keep last values */
        }
      }, 12000);
    }
  } catch (e) {
    setApiStatus(false, String(e.message || e));
    setPeersMsg(String(e.message || e), true);
    $("peers-table-wrap").innerHTML = "";
  }
}

const onboardingBundleDebounceMs = 380;
const onboardingBundlePlaceholder =
  "Fill peer fields & private key and load Overview (API). Scripts appear below when onboarding data is ready — Regenerate rotates the encrypted bundle.";
function clearOnboardingBundleScriptPanels() {
  const sn = $("onboard-bundle-snippet-cmd");
  if (sn) sn.textContent = onboardingBundlePlaceholder;
}

function setPeerEditorTab(which) {
  const onboarding = which === "onboard";
  const fieldsBtn = $("peer-tab-fields-btn");
  const onboardBtn = $("peer-tab-onboard-btn");
  const fieldsPanel = $("peer-tab-fields-panel");
  const onboardPanel = $("peer-tab-onboard-panel");
  if (!fieldsBtn || !onboardBtn || !fieldsPanel || !onboardPanel) return;
  fieldsBtn.classList.toggle("is-active", !onboarding);
  onboardBtn.classList.toggle("is-active", onboarding);
  fieldsBtn.setAttribute("aria-selected", onboarding ? "false" : "true");
  onboardBtn.setAttribute("aria-selected", onboarding ? "true" : "false");
  fieldsPanel.hidden = onboarding;
  onboardPanel.hidden = !onboarding;
}

function setOnboardMethodTab(which) {
  const tab = which === "other" ? "other" : "linux";
  const linuxBtn = $("onboard-tab-linux-btn");
  const otherBtn = $("onboard-tab-other-btn");
  const linuxPanel = $("onboard-tab-linux-panel");
  const otherPanel = $("onboard-tab-other-panel");
  if (!linuxBtn || !otherBtn || !linuxPanel || !otherPanel) return;
  linuxBtn.classList.toggle("is-active", tab === "linux");
  otherBtn.classList.toggle("is-active", tab === "other");
  linuxBtn.setAttribute("aria-selected", tab === "linux" ? "true" : "false");
  otherBtn.setAttribute("aria-selected", tab === "other" ? "true" : "false");
  linuxPanel.hidden = tab !== "linux";
  otherPanel.hidden = tab !== "other";
}

function closePeerQRModal() {
  const modal = $("peer-qr-modal");
  const wrap = $("peer-qr-canvas-wrap");
  if (wrap) wrap.innerHTML = "";
  if (modal) closeModal(modal);
  const msg = $("peer-qr-msg");
  if (msg) msg.textContent = "";
}

async function openPeerQRModal() {
  const conf = extractOnboardConfFromOutput();
  if (!conf) {
    setOnboardMsg("Build YAML + WireGuard config first.", true);
    return;
  }
  const idx = parseInt(($("peer-edit-index") && $("peer-edit-index").value) || "-1", 10);
  if (idx < 0) {
    setOnboardMsg("Save the peer first to show a stable QR.", true);
    return;
  }
  const modal = $("peer-qr-modal");
  const wrap = $("peer-qr-canvas-wrap");
  const msg = $("peer-qr-msg");
  if (!modal || !wrap) return;
  wrap.innerHTML = "";
  if (msg) msg.textContent = "Loading…";
  openModal(modal);
  try {
    const blob = await apiBlob("/v1/peers/" + idx + "/qr.png", {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: conf,
    });
    const url = URL.createObjectURL(blob);
    const img = document.createElement("img");
    img.src = url;
    img.alt = "WireGuard config QR code";
    img.onload = () => URL.revokeObjectURL(url);
    wrap.appendChild(img);
    if (msg) msg.textContent = "";
  } catch (e) {
    if (msg) msg.textContent = String(e.message || e);
  }
}

function openPeerEditor(index) {
  const cfg = state.lastConfig;
  if (!cfg || !cfg.peers[index]) return;
  resetPeerOnboardExtras();
  const p = cfg.peers[index];
  $("peer-edit-index").value = String(index);
  $("peer-editor-title").textContent = "Edit peer";
  $("peer-f-name").value = p.name || "";
  $("peer-f-tunnel").value = p.tunnel_ip || "";
  $("peer-f-pub").value = p.public_key || "";
  $("peer-f-disabled").checked = !p.disabled;
  const oe = $("onboard-endpoint");
  if (oe) oe.value = serverEndpointDisplay();
  const modal = $("peer-modal");
  if (modal) {
    openModal(modal);
    setPeerEditorTab("fields");
    const first = $("peer-f-name");
    if (first) requestAnimationFrame(() => first.focus());
  }
  void rebuildOnboardingEncryptedBundle(false);
  void fetchPeerOverviewForModal();
}

export function closePeerEditor() {
  state.peerOverviewFetchSeq++;
  if (state.peerOverviewDebounceTimer) {
    clearTimeout(state.peerOverviewDebounceTimer);
    state.peerOverviewDebounceTimer = null;
  }
  if (state.onboardingBundleDebounceTimer) {
    clearTimeout(state.onboardingBundleDebounceTimer);
    state.onboardingBundleDebounceTimer = null;
  }
  state.onboardingBundleRebuildSeq++;
  const modal = $("peer-modal");
  if (modal) closeModal(modal);
  $("peer-edit-index").value = "";
}

function resetPeerPrivRevealState() {
  const inp = $("onboard-client-priv");
  const btn = $("onboard-client-priv-toggle");
  if (inp) inp.type = "password";
  if (btn) {
    btn.textContent = "Show";
    btn.setAttribute("aria-label", "Show private key");
    btn.setAttribute("aria-pressed", "false");
  }
}

function resetPeerOnboardExtras() {
  state.onboardingUnlockPassStored = "";
  $("onboard-client-priv").value = "";
  resetPeerPrivRevealState();
  const out = $("onboard-out");
  if (out) {
    out.textContent = "";
    out.classList.add("is-collapsed");
  }
  const msg = $("onboard-msg");
  if (msg) msg.textContent = "";
  clearOnboardingBundleScriptPanels();
  setOnboardMethodTab("linux");
}

async function savePeerEditor() {
  const cfg = JSON.parse(JSON.stringify(state.lastConfig));
  if (!cfg.peers) cfg.peers = [];
  const idxRaw = $("peer-edit-index").value;
  const peer = {
    name: $("peer-f-name").value.trim(),
    tunnel_ip: $("peer-f-tunnel").value.trim(),
    public_key: $("peer-f-pub").value.trim(),
    disabled: !($("peer-f-disabled") && $("peer-f-disabled").checked),
  };
  if (!peer.name || !peer.tunnel_ip || !peer.public_key) {
    setPeersMsg("Name, tunnel IP, and public key are required.", true);
    return;
  }
  if (idxRaw === "") cfg.peers.push(peer);
  else cfg.peers[+idxRaw] = peer;
  try {
    await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
    state.lastConfig = cfg;
    setPeersMsg("Saved. Open Pending changes to review nftables, then Apply to host.");
    closePeerEditor();
    renderPeersTable(cfg);
    setApiStatus(true);
    refreshPendingBadge();
  } catch (e) {
    setPeersMsg(String(e.message || e), true);
  }
}

async function removePeer(index) {
  const cfg = state.lastConfig;
  if (!cfg || !cfg.peers || !cfg.peers[index]) return;
  const peerName = cfg.peers[index].name;
  openConfirmModal({
    title: "Remove peer?",
    message:
      "Remove \"" +
      peerName +
      "\" from the saved config? The host is not updated until you apply on Pending changes.",
    confirmLabel: "Remove",
    onConfirm: async () => {
      const c = JSON.parse(JSON.stringify(state.lastConfig));
      if (!c.peers) return;
      const i = c.peers.findIndex((p) => p.name === peerName);
      if (i < 0) return;
      c.peers.splice(i, 1);
      try {
        await api("/v1/config", { method: "PUT", body: JSON.stringify(c) });
        state.lastConfig = c;
        setPeersMsg("Peer removed from config. Apply on Pending changes when ready.");
        renderPeersTable(c);
        setApiStatus(true);
        refreshPendingBadge();
      } catch (e) {
        setPeersMsg(String(e.message || e), true);
      }
    },
  });
}

/* ——— Onboarding (keys + YAML) ——— */
function setOnboardMsg(text, isErr) {
  const el = $("onboard-msg");
  el.textContent = text;
  el.classList.toggle("err", !!isErr);
}

function u8ToB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function b64ToU8(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Web Crypto subtle is only available in secure contexts (HTTPS or localhost). */
function browserSubtleCryptoAvailable() {
  return !!(globalThis.isSecureContext && globalThis.crypto?.subtle);
}

function base64UrlToBytes(b64url) {
  let s = String(b64url || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "====".slice(0, 4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function generatePeerKeypairBrowser() {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.generateKey !== "function") {
    throw new Error("Web Crypto not available (use HTTPS or a modern browser).");
  }
  const pair = await subtle.generateKey({ name: "X25519" }, true, ["deriveBits"]);
  // Spec: raw export is not allowed for X25519 private keys; use JWK and decode `d`.
  const privJwk = await subtle.exportKey("jwk", pair.privateKey);
  if (!privJwk || !privJwk.d) {
    throw new Error("Could not export X25519 private key (JWK).");
  }
  const privRaw = base64UrlToBytes(privJwk.d);
  const pubRaw = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  if (privRaw.length !== 32 || pubRaw.length !== 32) {
    throw new Error("Unexpected X25519 key length.");
  }
  return {
    privateKey: u8ToB64(privRaw),
    publicKey: u8ToB64(pubRaw),
  };
}

/** Prefer browser keygen; fall back to authenticated API on plain HTTP (insecure testing). */
async function generatePeerKeypair() {
  if (browserSubtleCryptoAvailable()) return generatePeerKeypairBrowser();
  const body = await api("/v1/peers/generate-keypair", { method: "POST" });
  if (!body.private_key || !body.public_key) {
    throw new Error("API key generation returned an incomplete response.");
  }
  return { privateKey: body.private_key, publicKey: body.public_key };
}

function yamlPeerName(name) {
  const t = name.trim();
  if (/^[\w.-]+$/.test(t)) return t;
  return JSON.stringify(t);
}

function normalizeEndpoint(raw, listenPort) {
  const s = raw.trim();
  if (!s) return "";
  if (s.includes(":")) return s;
  if (listenPort > 0) return s + ":" + listenPort;
  return s;
}

function shellSingleQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function peerOnboardWireGuardParams() {
  const name = $("peer-f-name").value.trim();
  const tip = $("peer-f-tunnel").value.trim();
  const pub = $("peer-f-pub").value.trim();
  const priv = $("onboard-client-priv").value.trim();
  let ep = $("onboard-endpoint").value.trim();
  if (!name) return { ok: false, error: "Peer name is required." };
  if (!tip) return { ok: false, error: "Peer tunnel IP is required." };
  if (!pub) return { ok: false, error: "Peer public key is required." };
  if (!priv) return { ok: false, error: "Peer private key is required for the WireGuard profile." };
  const o = state.lastOverview;
  if (!o) return { ok: false, error: "Server details are not loaded yet. Check API status or edit a field to retry." };
  if (!o.server_public_key) return { ok: false, error: "Overview has no server public key." };
  const listenPort = Number(o.wireguard_listen_port) || 0;
  ep = normalizeEndpoint(ep, listenPort);
  if (!ep) return { ok: false, error: "Server endpoint (host:port) is required." };
  const subnet = o.tunnel_subnet || peerSubnetCidr();
  return {
    ok: true,
    name,
    tip,
    pub,
    priv,
    ep,
    serverPublicKey: o.server_public_key,
    subnet,
  };
}

/** WireGuard onboarding bundle (matches scripts/evuproxy-peer-bundle-apply.sh). */
const PEER_BUNDLE_VERSION = 1;
const PEER_BUNDLE_PBDF2_ITER = 310000;
const PEER_BUNDLE_MAGIC = new Uint8Array([69, 86, 85, 66]); // EVUB
// Default raw URL uses GitHub `main`: semver-pinned defaults would drift stale unless bumped every release. `main` is a moving branch.
// For reproducibility set window.EVUPROXY_PEER_TOOL_INSTALL_SCRIPT_URL to a tagged raw URL (checksum discipline).
const PEER_TOOL_INSTALL_SCRIPT_DEFAULT =
  "https://raw.githubusercontent.com/imevul/evuproxy/main/scripts/install-peer-tool.sh";

function concatUint8Arrays(...parts) {
  let len = 0;
  for (let i = 0; i < parts.length; i++) len += parts[i].length;
  const out = new Uint8Array(len);
  let o = 0;
  for (let i = 0; i < parts.length; i++) {
    out.set(parts[i], o);
    o += parts[i].length;
  }
  return out;
}

function randomUnlockPassphraseHex() {
  const u = new Uint8Array(24);
  globalThis.crypto.getRandomValues(u);
  let hex = "";
  for (let i = 0; i < u.length; i++) hex += u[i].toString(16).padStart(2, "0");
  return hex;
}

async function peerBundleEncryptedBytesBrowser(passphraseStr, wgParams) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto not available (use HTTPS).");
  const enc = new TextEncoder();
  const passBytes = enc.encode(passphraseStr);
  const plainObj = {
    v: PEER_BUNDLE_VERSION,
    peerPrivateKey: wgParams.priv,
    peerTunnelAddress: wgParams.tip,
    serverPublicKey: wgParams.serverPublicKey,
    endpoint: wgParams.ep,
    allowedIPs: wgParams.subnet,
    interfaceName: "evuproxy",
  };
  const plainBytes = enc.encode(JSON.stringify(plainObj));
  const salt = new Uint8Array(16);
  globalThis.crypto.getRandomValues(salt);
  const passphraseKeyMat = await subtle.importKey("raw", passBytes, "PBKDF2", false, ["deriveBits"]);
  const dk = new Uint8Array(
    await subtle.deriveBits(
      {
        name: "PBKDF2",
        salt,
        iterations: PEER_BUNDLE_PBDF2_ITER,
        hash: "SHA-256",
      },
      passphraseKeyMat,
      512,
    ),
  );
  const aesKeyBytes = dk.subarray(0, 32);
  const macKeyBytes = dk.subarray(32, 64);
  const iv = new Uint8Array(16);
  globalThis.crypto.getRandomValues(iv);
  const aesImported = await subtle.importKey("raw", aesKeyBytes, "AES-CBC", false, ["encrypt"]);
  const plainSlice = plainBytes.buffer.slice(
    plainBytes.byteOffset,
    plainBytes.byteOffset + plainBytes.byteLength,
  );
  const ciphertextBuf = await subtle.encrypt({ name: "AES-CBC", iv }, aesImported, plainSlice);
  const ciphertext = new Uint8Array(ciphertextBuf);
  const macPayload = concatUint8Arrays(iv, ciphertext);
  const macKeyImp = await subtle.importKey("raw", macKeyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const macSig = await subtle.sign("HMAC", macKeyImp, macPayload);
  const mac = new Uint8Array(macSig);

  const headerLen = 4 + 1 + 4 + 1 + 16 + 16 + 4;
  const total = headerLen + ciphertext.length + mac.length;
  const out = new Uint8Array(total);
  let o = 0;
  out.set(PEER_BUNDLE_MAGIC, o);
  o += 4;
  out[o++] = PEER_BUNDLE_VERSION;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(o, PEER_BUNDLE_PBDF2_ITER, false);
  o += 4;
  out[o++] = 16;
  out.set(salt, o);
  o += 16;
  out.set(iv, o);
  o += 16;
  dv.setUint32(o, ciphertext.length, false);
  o += 4;
  out.set(ciphertext, o);
  o += ciphertext.length;
  out.set(mac, o);
  return out;
}

async function peerBundleEncryptedBytes(passphraseStr, wgParams) {
  if (browserSubtleCryptoAvailable()) {
    return peerBundleEncryptedBytesBrowser(passphraseStr, wgParams);
  }
  const body = await api("/v1/peers/onboard-bundle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      passphrase: passphraseStr,
      peer_private_key: wgParams.priv,
      peer_tunnel_address: wgParams.tip,
      server_public_key: wgParams.serverPublicKey,
      endpoint: wgParams.ep,
      allowed_ips: wgParams.subnet,
      interface_name: "evuproxy",
    }),
  });
  if (!body.blob_base64) {
    throw new Error("API onboard bundle returned an incomplete response.");
  }
  return b64ToU8(body.blob_base64);
}

function peerToolInstallUrlResolved() {
  return typeof window.EVUPROXY_PEER_TOOL_INSTALL_SCRIPT_URL === "string" &&
    window.EVUPROXY_PEER_TOOL_INSTALL_SCRIPT_URL.trim() !== ""
    ? window.EVUPROXY_PEER_TOOL_INSTALL_SCRIPT_URL.trim()
    : PEER_TOOL_INSTALL_SCRIPT_DEFAULT;
}

function buildPeerTwoLineSnippet(passHex, blobB64) {
  const q = shellSingleQuote;
  const installUrl = q(peerToolInstallUrlResolved());
  return [
    "export EVU_SECRET_FROM_ADMIN=" + q(passHex),
    "export EVU_BLOB_FROM_ADMIN=" + q(blobB64),
    "curl --proto '=https' --proto-redir '=https' -fsSL " + installUrl + " | sudo bash",
    "sudo evuproxy-peer-apply \\",
    '  --secret "$(printf \'%s\' "$EVU_SECRET_FROM_ADMIN")" \\',
    '  --blob "$(printf \'%s\' "$EVU_BLOB_FROM_ADMIN")"',
  ].join("\n");
}

function scheduleDebouncedOnboardingEncryptedBundle(forceNewUnlock) {
  if (state.onboardingBundleDebounceTimer) clearTimeout(state.onboardingBundleDebounceTimer);
  state.onboardingBundleDebounceTimer = setTimeout(() => {
    state.onboardingBundleDebounceTimer = null;
    void rebuildOnboardingEncryptedBundle(forceNewUnlock);
  }, onboardingBundleDebounceMs);
}

async function rebuildOnboardingEncryptedBundle(forceNewUnlock) {
  const seq = ++state.onboardingBundleRebuildSeq;
  const sn = $("onboard-bundle-snippet-cmd");
  if (!sn) return;
  const r = peerOnboardWireGuardParams();
  if (!r.ok) {
    if (seq !== state.onboardingBundleRebuildSeq) return;
    if (forceNewUnlock) state.onboardingUnlockPassStored = "";
    clearOnboardingBundleScriptPanels();
    return;
  }
  try {
    if (forceNewUnlock || !state.onboardingUnlockPassStored) {
      state.onboardingUnlockPassStored = randomUnlockPassphraseHex();
    }
    const bytes = await peerBundleEncryptedBytes(state.onboardingUnlockPassStored, r);
    if (seq !== state.onboardingBundleRebuildSeq) return;
    const blobB64 = u8ToB64(bytes);
    sn.textContent = buildPeerTwoLineSnippet(state.onboardingUnlockPassStored, blobB64);
  } catch (e) {
    if (seq !== state.onboardingBundleRebuildSeq) return;
    setOnboardMsg(String(e.message || e), true);
    clearOnboardingBundleScriptPanels();
  }
}

async function copyOnboardingFieldOrCmd(getter, missingMsg, okMsg) {
  const raw = getter();
  let text = "";
  if (raw != null && typeof raw.value === "string") text = raw.value.trim();
  else if (raw != null) text = String(raw.textContent || "").trim();

  if (!text || text === onboardingBundlePlaceholder) {
    setOnboardMsg(missingMsg, true);
    return;
  }
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
      setOnboardMsg("Clipboard is not available in this context (try HTTPS or localhost).", true);
      return;
    }
    await navigator.clipboard.writeText(text);
    setOnboardMsg(okMsg);
  } catch (e) {
    setOnboardMsg(String(e.message || e), true);
  }
}

function updateServerHint(o) {
  const el = $("onboard-server-hint");
  if (!o || !o.server_public_key) {
    el.classList.add("is-hidden");
    el.textContent = "";
    return;
  }
  const pubShort =
    o.server_public_key.length > 28
      ? o.server_public_key.slice(0, 14) + "…" + o.server_public_key.slice(-10)
      : o.server_public_key;
  el.textContent =
    "Server public key: " +
    pubShort +
    " · Listen UDP " +
    o.wireguard_listen_port +
    " · Tunnel " +
    (o.tunnel_subnet || "(unknown)") +
    ".";
  el.classList.remove("is-hidden");
}

function schedulePeerOverviewFromModal() {
  const pm = $("peer-modal");
  if (!pm || pm.classList.contains("is-hidden")) return;
  if (state.peerOverviewDebounceTimer) clearTimeout(state.peerOverviewDebounceTimer);
  state.peerOverviewDebounceTimer = setTimeout(() => {
    state.peerOverviewDebounceTimer = null;
    void fetchPeerOverviewForModal();
  }, 400);
}

async function fetchPeerOverviewForModal() {
  const pm = $("peer-modal");
  if (!pm || pm.classList.contains("is-hidden")) return;
  const seq = ++state.peerOverviewFetchSeq;
  try {
    const j = await api("/v1/overview");
    if (seq !== state.peerOverviewFetchSeq) return;
    state.lastOverview = j;
    updateServerHint(j);
    if (state.onboardingBundleDebounceTimer) clearTimeout(state.onboardingBundleDebounceTimer);
    state.onboardingBundleDebounceTimer = null;
    void rebuildOnboardingEncryptedBundle(false);
  } catch (e) {
    if (seq !== state.peerOverviewFetchSeq) return;
    setOnboardMsg(String(e.message || e), true);
  }
}

function extractOnboardConfFromOutput() {
  const out = ($("onboard-out") && $("onboard-out").textContent) || "";
  const idx = out.indexOf("[Interface]");
  if (idx < 0) return "";
  return out.slice(idx).trim();
}

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initPeersPage() {
  $("peers-refresh").addEventListener("click", refreshPeersPage);
  const peerTabFieldsBtn = $("peer-tab-fields-btn");
  const peerTabOnboardBtn = $("peer-tab-onboard-btn");
  if (peerTabFieldsBtn)
    peerTabFieldsBtn.addEventListener("click", () => setPeerEditorTab("fields"));
  if (peerTabOnboardBtn)
    peerTabOnboardBtn.addEventListener("click", () => setPeerEditorTab("onboard"));
  const onboardTabLinuxBtn = $("onboard-tab-linux-btn");
  const onboardTabOtherBtn = $("onboard-tab-other-btn");
  if (onboardTabLinuxBtn) onboardTabLinuxBtn.addEventListener("click", () => setOnboardMethodTab("linux"));
  if (onboardTabOtherBtn) onboardTabOtherBtn.addEventListener("click", () => setOnboardMethodTab("other"));
  const onboardShowQR = $("onboard-show-qr");
  if (onboardShowQR) onboardShowQR.addEventListener("click", () => void openPeerQRModal());
  const peerQrClose = $("peer-qr-close");
  if (peerQrClose) peerQrClose.addEventListener("click", closePeerQRModal);
  const peerQrModal = $("peer-qr-modal");
  if (peerQrModal) {
    const backdrop = peerQrModal.querySelector(".modal-backdrop");
    if (backdrop) backdrop.addEventListener("click", closePeerQRModal);
  }

  $("peers-add-start").addEventListener("click", async () => {
    if (!state.lastConfig) return;
    $("peer-edit-index").value = "";
    $("peer-editor-title").textContent = "Add peer";
    $("peer-f-name").value = "";
    $("peer-f-tunnel").value = suggestedPeerTunnelIP(state.lastConfig);
    $("peer-f-pub").value = "";
    $("peer-f-disabled").checked = true;
    resetPeerOnboardExtras();
    const oe = $("onboard-endpoint");
    if (oe) oe.value = serverEndpointDisplay();
    const modal = $("peer-modal");
    if (modal) {
      openModal(modal);
      setPeerEditorTab("fields");
    }
    try {
      const kp = await generatePeerKeypair();
      $("peer-f-pub").value = kp.publicKey;
      $("onboard-client-priv").value = kp.privateKey;
    } catch (e) {
      setPeersMsg(String(e.message || e), true);
    }
    void rebuildOnboardingEncryptedBundle(false);
    void fetchPeerOverviewForModal();
    const first = $("peer-f-name");
    if (first) requestAnimationFrame(() => first.focus());
  });
  $("peer-save").addEventListener("click", savePeerEditor);
  $("peer-cancel").addEventListener("click", closePeerEditor);

  $("onboard-client-priv-toggle").addEventListener("click", () => {
    const inp = $("onboard-client-priv");
    const btn = $("onboard-client-priv-toggle");
    if (!inp || !btn) return;
    const show = inp.type === "password";
    inp.type = show ? "text" : "password";
    btn.textContent = show ? "Hide" : "Show";
    btn.setAttribute("aria-label", show ? "Hide private key" : "Show private key");
    btn.setAttribute("aria-pressed", show ? "true" : "false");
  });

  $("onboard-clear-keys").addEventListener("click", async () => {
    const adding = $("peer-edit-index").value === "";
    $("peer-f-pub").value = "";
    $("onboard-client-priv").value = "";
    if (!adding) {
      setOnboardMsg("Keys cleared.");
      void rebuildOnboardingEncryptedBundle(false);
      return;
    }
    setOnboardMsg("…");
    try {
      const kp = await generatePeerKeypair();
      $("peer-f-pub").value = kp.publicKey;
      $("onboard-client-priv").value = kp.privateKey;
      setOnboardMsg("New keypair generated.");
      void rebuildOnboardingEncryptedBundle(false);
    } catch (e) {
      setOnboardMsg(String(e.message || e), true);
    }
  });
  $("onboard-build").addEventListener("click", () => {
    setOnboardMsg("…");
    const r = peerOnboardWireGuardParams();
    if (!r.ok) {
      setOnboardMsg(r.error, true);
      return;
    }
    const { name, tip, pub, priv, ep, serverPublicKey, subnet } = r;
    const peerYaml =
      "  - name: " +
      yamlPeerName(name) +
      "\n" +
      "    public_key: " +
      pub +
      "\n" +
      "    tunnel_ip: " +
      tip +
      "\n";
    const conf =
      "[Interface]\n" +
      "PrivateKey = " +
      priv +
      "\n" +
      "Address = " +
      tip +
      "\n\n" +
      "[Peer]\n" +
      "PublicKey = " +
      serverPublicKey +
      "\n" +
      "Endpoint = " +
      ep +
      "\n" +
      "AllowedIPs = " +
      subnet +
      "\n" +
      "PersistentKeepalive = 25\n";
    const block =
      "# --- peers: snippet ---\n\n" +
      peerYaml +
      "\n# --- WireGuard peer config (e.g. save as client.conf) ---\n\n" +
      conf;
    $("onboard-out").textContent = block;
    $("onboard-out").classList.remove("is-collapsed");
    setOnboardMsg("Output below.");
  });

  const obDlConf = $("onboard-download-conf");
  if (obDlConf) {
    obDlConf.addEventListener("click", () => {
      const conf = extractOnboardConfFromOutput();
      if (!conf) {
        setOnboardMsg("Build YAML + WireGuard config first.", true);
        return;
      }
      const name = ($("peer-f-name") && $("peer-f-name").value.trim()) || "peer";
      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      downloadTextFile("evuproxy-" + safe + ".conf", conf, "text/plain;charset=utf-8");
      setOnboardMsg("Downloaded .conf");
    });
  }
  const obDlSh = $("onboard-download-sh");
  if (obDlSh) {
    obDlSh.addEventListener("click", () => {
      const sn = $("onboard-bundle-snippet-cmd");
      const txt = sn && sn.textContent ? sn.textContent.trim() : "";
      if (!txt || txt === onboardingBundlePlaceholder) {
        setOnboardMsg("Onboarding bundle not ready — fill peer fields and wait for Overview.", true);
        return;
      }
      const name = ($("peer-f-name") && $("peer-f-name").value.trim()) || "peer";
      const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "-");
      downloadTextFile("evuproxy-peer-" + safe + "-onboard.sh", txt + "\n", "text/x-shellscript;charset=utf-8");
      setOnboardMsg("Downloaded command snippet.");
    });
  }

  const obCopySnip = $("onboard-bundle-copy-snippet");
  if (obCopySnip) {
    obCopySnip.addEventListener("click", async () =>
      copyOnboardingFieldOrCmd(() => $("onboard-bundle-snippet-cmd"), "Commands not ready yet.", "Copied commands."),
    );
  }
  const obRegen = $("onboard-bundle-regenerate-unlock");
  if (obRegen) {
    obRegen.addEventListener("click", () => {
      state.onboardingUnlockPassStored = "";
      void rebuildOnboardingEncryptedBundle(true);
    });
  }

  function onPeerModalFieldActivity() {
    const pm = $("peer-modal");
    if (!pm || pm.classList.contains("is-hidden")) return;
    scheduleDebouncedOnboardingEncryptedBundle(false);
    schedulePeerOverviewFromModal();
  }

  ["peer-f-name", "peer-f-tunnel", "peer-f-pub", "onboard-endpoint", "onboard-client-priv"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", onPeerModalFieldActivity);
  });
  const peerDisabled = $("peer-f-disabled");
  if (peerDisabled) peerDisabled.addEventListener("change", onPeerModalFieldActivity);

  const peerModal = $("peer-modal");
  const peerBackdrop = peerModal && peerModal.querySelector(".modal-backdrop");
  if (peerBackdrop) peerBackdrop.addEventListener("click", closePeerEditor);
}
