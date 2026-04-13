(function () {
  const apiBaseKey = "evuproxy_api_base";

  function normalizeApiBase(s) {
    s = String(s).trim().replace(/\/+$/, "");
    return s || "/api";
  }

  function getDefaultApiBase() {
    if (typeof window.EVUPROXY_API === "string" && window.EVUPROXY_API.trim() !== "") {
      return normalizeApiBase(window.EVUPROXY_API);
    }
    return "/api";
  }

  function getApiBase() {
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

  const peerInstallScriptUrl =
    window.EVUPROXY_PEER_INSTALL_SCRIPT_URL ||
    "https://raw.githubusercontent.com/imevul/evuproxy/main/scripts/peer-install.sh";
  const tokenKey = "evuproxy_api_token";
  const endpointKey = "evuproxy_onboard_endpoint";
  const peerSubnetKey = "evuproxy_peer_subnet_cidr";
  const defaultPeerSubnetCidr = "10.100.0.0/24";
  const advancedSettingsKey = "evuproxy_advanced_settings";

  const $ = (id) => document.getElementById(id);

  let lastOverview = null;
  let lastConfig = null;
  /** True only after a successful GET /v1/overview with the current token (or unset token → false). */
  let apiConnectionOk = false;
  /** Last /v1/stats response for peer online/offline column (null if unavailable). */
  let lastPeerWgStats = null;
  let peerOverviewFetchSeq = 0;
  let peerOverviewDebounceTimer = null;
  /** Ignores stale results when multiple refreshOverviewPage runs overlap (navigate + save-token, etc.). */
  let overviewRefreshSeq = 0;

  const pages = [
    "overview",
    "settings",
    "token",
    "peers",
    "routes",
    "inbound",
    "geoblocking",
    "pending",
    "stats",
    "logs",
  ];

  let lastUIPrefs = {
    peer_tunnel_subnet_cidr: "",
    wireguard_server_endpoint: "",
  };
  let uiPrefsFetched = false;

  function invalidateUIPrefsCache() {
    uiPrefsFetched = false;
  }

  function migrateFromLocalStorageIfEmpty() {
    try {
      if (!lastUIPrefs.peer_tunnel_subnet_cidr) {
        const s = localStorage.getItem(peerSubnetKey);
        if (s && String(s).trim()) lastUIPrefs.peer_tunnel_subnet_cidr = String(s).trim();
      }
      if (!lastUIPrefs.wireguard_server_endpoint) {
        const s = localStorage.getItem(endpointKey);
        if (s && String(s).trim()) lastUIPrefs.wireguard_server_endpoint = String(s).trim();
      }
    } catch (e) {
      /* ignore */
    }
  }

  async function fetchUIPrefsFromServer() {
    const p = await api("/v1/preferences");
    lastUIPrefs = {
      peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
      wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
    };
    migrateFromLocalStorageIfEmpty();
  }

  async function ensureUIPrefs() {
    if (uiPrefsFetched) return;
    try {
      await fetchUIPrefsFromServer();
    } catch {
      lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "" };
      migrateFromLocalStorageIfEmpty();
    }
    uiPrefsFetched = true;
  }

  function token() {
    return sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || ($("token") && $("token").value.trim()) || "";
  }

  function headers() {
    const t = token();
    const h = { Accept: "application/json", "Content-Type": "application/json" };
    if (t) h["X-API-Token"] = t;
    return h;
  }

  function setApiStatus(ok, detail) {
    const el = $("api-status");
    if (!el) return;
    el.textContent = ok ? "API OK" : "API error";
    el.classList.remove("pill-muted", "pill-ok", "pill-err");
    el.classList.add(ok ? "pill-ok" : "pill-err");
    if (detail) el.title = detail;
  }

  function applyNavRestriction() {
    const restricted = !apiConnectionOk;
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

  /** Returns true when the API is reachable with the current token (also sets lastOverview on success). */
  async function ensureApiGate() {
    const t = token().trim();
    if (!t) {
      apiConnectionOk = false;
      applyNavRestriction();
      return false;
    }
    try {
      const o = await api("/v1/overview");
      lastOverview = o;
      apiConnectionOk = true;
      applyNavRestriction();
      return true;
    } catch {
      apiConnectionOk = false;
      applyNavRestriction();
      return false;
    }
  }

  async function api(path, opts = {}) {
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
      throw new Error(err);
    }
    return body;
  }

  let confirmModalCallback = null;

  function closeConfirmModal() {
    confirmModalCallback = null;
    const m = $("confirm-modal");
    if (m) m.classList.add("is-hidden");
  }

  function openConfirmModal(opts) {
    const titleEl = $("confirm-modal-title");
    const descEl = $("confirm-modal-desc");
    const okBtn = $("confirm-modal-ok");
    const modal = $("confirm-modal");
    if (!titleEl || !descEl || !okBtn || !modal) return;
    titleEl.textContent = opts.title || "Confirm";
    descEl.textContent = opts.message || "";
    okBtn.textContent = opts.confirmLabel || "OK";
    confirmModalCallback = opts.onConfirm || null;
    modal.classList.remove("is-hidden");
    const cancelBtn = $("confirm-modal-cancel");
    if (cancelBtn) requestAnimationFrame(() => cancelBtn.focus());
  }

  async function navigate(name) {
    if (!pages.includes(name)) name = "overview";
    closeConfirmModal();
    if (name !== "routes") closeRouteEditor();
    if (name !== "inbound") closeInboundEditor();
    if (name !== "peers") closePeerEditor();
    if (name !== "overview" && name !== "token") {
      const ok = await ensureApiGate();
      if (!ok) name = "overview";
    }
    applyNavRestriction();
    await ensureUIPrefs();
    document.querySelectorAll(".page").forEach((p) => {
      p.hidden = true;
    });
    const sec = $("page-" + name);
    if (sec) sec.hidden = false;
    document.querySelectorAll(".nav-link").forEach((a) => {
      a.classList.toggle("is-active", a.getAttribute("data-route") === name);
    });
    if (location.hash.replace(/^#\/?/, "") !== name) {
      location.hash = "#/" + name;
    }
    if (name === "overview") await refreshOverviewPage();
    if (name === "settings") await refreshSettingsPage();
    if (name === "token") {
      refreshTokenPage();
      await ensureApiGate();
    }
    if (name === "peers") refreshPeersPage();
    if (name === "routes") refreshRoutesPage();
    if (name === "inbound") refreshInboundPage();
    if (name === "geoblocking") await refreshGeoblockingPage();
    if (name === "pending") refreshPendingPage();
    if (name === "stats") refreshStatsPage();
    if (name === "logs") refreshLogsPage();
    refreshPendingBadge();
    void refreshSidebarAbout();
  }

  async function onHash() {
    const h = (location.hash || "#/overview").replace(/^#\/?/, "").split("/")[0];
    await navigate(h || "overview");
  }

  /* ——— Overview ——— */
  function elStat(label, value) {
    const d = document.createElement("div");
    d.className = "stat-card";
    d.innerHTML = "<p class=\"label\"></p><p class=\"value\"></p>";
    d.querySelector(".label").textContent = label;
    d.querySelector(".value").textContent = value;
    return d;
  }

  function overviewApiIssueCard(opts) {
    const wrap = document.createElement("div");
    wrap.className = "card overview-api-issue-card";
    const p = document.createElement("p");
    p.textContent = opts.message;
    wrap.appendChild(p);
    const linkP = document.createElement("p");
    linkP.className = "hint";
    linkP.style.marginTop = "0.75rem";
    const a = document.createElement("a");
    a.href = "#/token";
    a.textContent = "Open API token";
    linkP.appendChild(a);
    linkP.appendChild(document.createTextNode(" to set the token and optional API base URL."));
    wrap.appendChild(linkP);
    if (opts.detail) {
      const d = document.createElement("p");
      d.className = "hint meta";
      d.style.marginTop = "0.5rem";
      d.textContent = opts.detail;
      wrap.appendChild(d);
    }
    return wrap;
  }

  async function refreshOverviewPage() {
    const seq = ++overviewRefreshSeq;
    const grid = $("overview-cards");
    const msg = $("overview-action-msg");
    const actionsCard = $("overview-actions-card");
    if (!grid) return;
    grid.innerHTML = "";
    msg.textContent = "";
    if (!token().trim()) {
      if (seq !== overviewRefreshSeq) return;
      apiConnectionOk = false;
      applyNavRestriction();
      setApiStatus(false, "No API token");
      grid.appendChild(
        overviewApiIssueCard({
          message: "There is a problem with the API: no token is configured in this browser.",
        })
      );
      if (actionsCard) actionsCard.hidden = true;
      return;
    }
    try {
      const o = await api("/v1/overview");
      if (seq !== overviewRefreshSeq) return;
      lastOverview = o;
      apiConnectionOk = true;
      applyNavRestriction();
      setApiStatus(true);
      if (actionsCard) actionsCard.hidden = false;
      grid.appendChild(elStat("WireGuard", o.wireguard_interface + " · UDP " + o.wireguard_listen_port));
      grid.appendChild(elStat("Public NIC", o.public_interface));
      const n = (o.forwarding_routes && o.forwarding_routes.length) || 0;
      const fwd = n + " route(s)";
      grid.appendChild(elStat("Forwarding", fwd));
      grid.appendChild(
        elStat(
          "Geo",
          o.geo_enabled
            ? (o.geo_mode === "block" ? "block " : "allow ") + (o.geo_countries || []).join(", ")
            : "off"
        )
      );
      grid.appendChild(elStat("Peers", String((o.peer_names || []).length)));
    } catch (e) {
      if (seq !== overviewRefreshSeq) return;
      const errText = String(e.message || e);
      apiConnectionOk = false;
      applyNavRestriction();
      setApiStatus(false, errText);
      if (actionsCard) actionsCard.hidden = true;
      grid.appendChild(
        overviewApiIssueCard({
          message:
            "There is a problem with the API: the EvuProxy API could not be reached or rejected this browser’s request.",
          detail: errText,
        })
      );
    }
  }

  function setOverviewMsg(text, isErr) {
    const el = $("overview-action-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  /* ——— Settings ——— */
  function advancedSettingsEnabled() {
    try {
      return localStorage.getItem(advancedSettingsKey) === "1";
    } catch (e) {
      return false;
    }
  }

  function setAdvancedSettingsEnabled(on) {
    try {
      if (on) localStorage.setItem(advancedSettingsKey, "1");
      else localStorage.removeItem(advancedSettingsKey);
    } catch (e) {
      /* ignore */
    }
    syncAdvancedSettingsToggle();
  }

  function syncAdvancedSettingsToggle() {
    const cb = $("settings-advanced-toggle");
    if (!cb) return;
    cb.checked = advancedSettingsEnabled();
  }

  function syncGeoAdvancedFieldsVisibility() {
    const adv = advancedSettingsEnabled();
    const fields = $("geo-advanced-fields");
    const teaser = $("geo-advanced-fields-teaser");
    if (!fields || !teaser) return;
    fields.hidden = !adv;
    teaser.hidden = adv;
  }

  function setAuthMsg(text, isErr) {
    const el = $("auth-msg");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  async function refreshSettingsPage() {
    const msg = $("settings-prefs-msg");
    if (msg) {
      msg.textContent = "";
      msg.classList.remove("err");
    }
    try {
      await fetchUIPrefsFromServer();
      uiPrefsFetched = true;
      setApiStatus(true);
    } catch (e) {
      if (msg) {
        msg.textContent = String(e.message || e);
        msg.classList.add("err");
      }
      setApiStatus(false, String(e.message || e));
      lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "" };
      migrateFromLocalStorageIfEmpty();
    }
    const cidr = $("peer-subnet-cidr");
    if (cidr) cidr.value = (lastUIPrefs.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr;
    const sep = $("settings-wg-endpoint");
    if (sep) sep.value = (lastUIPrefs.wireguard_server_endpoint || "").trim();
    syncAdvancedSettingsToggle();
  }

  function refreshTokenPage() {
    const el = $("token");
    if (el) el.value = sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
    const ab = $("api-base");
    if (ab) {
      const saved = sessionStorage.getItem(apiBaseKey) || localStorage.getItem(apiBaseKey);
      ab.value = saved != null && String(saved).trim() !== "" ? String(saved).trim() : "";
    }
  }

  function serverEndpointDisplay() {
    return (lastUIPrefs.wireguard_server_endpoint || "").trim();
  }

  function peerSubnetCidr() {
    const v = (lastUIPrefs.peer_tunnel_subnet_cidr || "").trim();
    if (v && parseIPv4CIDR(v)) return v;
    return defaultPeerSubnetCidr;
  }

  function ipv4ToInt(s) {
    const p = String(s || "")
      .trim()
      .split(".");
    if (p.length !== 4) return null;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const x = +p[i];
      if (x !== (x | 0) || x < 0 || x > 255) return null;
      n = ((n << 8) | x) >>> 0;
    }
    return n;
  }

  function intToIpv4(n) {
    n = n >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }

  function parseIPv4CIDR(cidr) {
    const m = String(cidr || "")
      .trim()
      .match(/^([\d.]+)\/(\d+)$/);
    if (!m) return null;
    const prefix = +m[2];
    if (prefix < 0 || prefix > 32) return null;
    const ip = ipv4ToInt(m[1]);
    if (ip === null) return null;
    if (prefix === 32) {
      return { network: ip, broadcast: ip, prefix, mask: 0xffffffff };
    }
    const mask = ((-1) << (32 - prefix)) >>> 0;
    const network = (ip & mask) >>> 0;
    const broadcast = (network | (~mask >>> 0)) >>> 0;
    return { network, broadcast, prefix, mask };
  }

  function ipInCidr(ipInt, parsed) {
    return ipInt >= parsed.network && ipInt <= parsed.broadcast;
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

  /** Handshake age at or below this (seconds) counts as "online". */
  const PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC = 180;

  function wgPeerPubKeyMap(st) {
    const m = new Map();
    if (!st || !Array.isArray(st.wireguard_peers)) return m;
    for (const row of st.wireguard_peers) {
      const k = String(row.public_key || "").trim();
      if (k) m.set(k, row);
    }
    return m;
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

  function renderPeersTable(cfg, wgStats) {
    const wrap = $("peers-table-wrap");
    if (wgStats === undefined) wgStats = lastPeerWgStats;
    if (!cfg || !cfg.peers) {
      wrap.innerHTML = "<p class=\"hint\">No peers.</p>";
      return;
    }
    const wgWarn =
      wgStats && wgStats.wireguard_dump_failed
        ? '<p class="hint">WireGuard peer status unavailable (<code>wg show</code> failed — interface down or tools missing).</p>'
        : "";
    const pubMap = wgPeerPubKeyMap(wgStats);
    const rows = cfg.peers
      .map(
        (p, i) =>
          `<tr><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.tunnel_ip)}</td><td class="mono">${escapeHtml(trunc(p.public_key, 20))}</td><td>${peerConnectionStatusHtml(p, pubMap)}</td>${tableDisabledToggleCell("data-peer-disabled", i, !!p.disabled, "Enabled: " + String(p.name || "peer"))}<td class="row-actions"><button type="button" data-peer-edit="${i}">Edit</button> <button type="button" data-peer-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      )
      .join("");
    wrap.innerHTML = `${wgWarn}<table class="data"><thead><tr><th>Name</th><th>Tunnel IP</th><th>Public key</th><th>Status</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
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
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function trunc(s, n) {
    s = String(s || "");
    if (s.length <= n) return s;
    return s.slice(0, Math.floor(n / 2)) + "…" + s.slice(-Math.floor(n / 3));
  }

  function tableDisabledToggleCell(dataAttr, index, disabled, ariaLabel) {
    const ch = disabled ? "" : " checked";
    return (
      `<td class="cell-disabled-toggle"><label class="toggle-switch" aria-label="${escapeHtml(ariaLabel)}">` +
      `<input type="checkbox" class="toggle-switch-input" ${dataAttr}="${index}"${ch} />` +
      `<span class="toggle-switch-track" aria-hidden="true"><span class="toggle-switch-thumb"></span></span>` +
      `</label></td>`
    );
  }

  async function patchPeerDisabled(index, disabled) {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.peers || cfg.peers[index] === undefined) return;
    cfg.peers[index].disabled = disabled;
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setPeersMsg("");
      setApiStatus(true);
      refreshPendingBadge();
      renderPeersTable(cfg, lastPeerWgStats);
    } catch (e) {
      setPeersMsg(String(e.message || e), true);
      renderPeersTable(lastConfig, lastPeerWgStats);
    }
  }

  async function patchRouteDisabled(index, disabled) {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.forwarding || !cfg.forwarding.routes || cfg.forwarding.routes[index] === undefined) return;
    cfg.forwarding.routes[index].disabled = disabled;
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setRoutesMsg("");
      setApiStatus(true);
      refreshPendingBadge();
      renderRoutesTable(cfg);
    } catch (e) {
      setRoutesMsg(String(e.message || e), true);
      renderRoutesTable(lastConfig);
    }
  }

  async function patchInboundDisabled(index, disabled) {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.input_allows || cfg.input_allows[index] === undefined) return;
    cfg.input_allows[index].disabled = disabled;
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setInboundMsg("");
      setApiStatus(true);
      refreshPendingBadge();
      renderInboundTable(cfg);
    } catch (e) {
      setInboundMsg(String(e.message || e), true);
      renderInboundTable(lastConfig);
    }
  }

  async function refreshPeersPage() {
    setPeersMsg("");
    try {
      const [cfgOut, stOut] = await Promise.allSettled([api("/v1/config"), api("/v1/stats")]);
      if (cfgOut.status !== "fulfilled") {
        throw cfgOut.reason;
      }
      lastConfig = cfgOut.value;
      lastPeerWgStats = stOut.status === "fulfilled" ? stOut.value : null;
      setApiStatus(true);
      renderPeersTable(lastConfig, lastPeerWgStats);
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setPeersMsg(String(e.message || e), true);
      $("peers-table-wrap").innerHTML = "";
    }
  }

  function openPeerEditor(index) {
    const cfg = lastConfig;
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
      modal.classList.remove("is-hidden");
      const first = $("peer-f-name");
      if (first) requestAnimationFrame(() => first.focus());
    }
    refreshOnboardInstallCmd();
    void fetchPeerOverviewForModal();
  }

  function closePeerEditor() {
    peerOverviewFetchSeq++;
    if (peerOverviewDebounceTimer) {
      clearTimeout(peerOverviewDebounceTimer);
      peerOverviewDebounceTimer = null;
    }
    const modal = $("peer-modal");
    if (modal) modal.classList.add("is-hidden");
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
    $("onboard-client-priv").value = "";
    resetPeerPrivRevealState();
    const out = $("onboard-out");
    if (out) {
      out.textContent = "";
      out.classList.add("is-collapsed");
    }
    const msg = $("onboard-msg");
    if (msg) msg.textContent = "";
    const ic = $("onboard-install-cmd");
    if (ic) ic.textContent = onboardInstallCmdPlaceholder;
  }

  async function savePeerEditor() {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
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
      lastConfig = cfg;
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
    const cfg = lastConfig;
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
        const c = JSON.parse(JSON.stringify(lastConfig));
        if (!c.peers) return;
        const i = c.peers.findIndex((p) => p.name === peerName);
        if (i < 0) return;
        c.peers.splice(i, 1);
        try {
          await api("/v1/config", { method: "PUT", body: JSON.stringify(c) });
          lastConfig = c;
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

  /* ——— Routes ——— */
  function setRoutesMsg(text, isErr) {
    const el = $("routes-msg");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  function peerTunnelIPv4Options(cfg) {
    const sel = $("route-f-target");
    sel.innerHTML = "";
    (cfg.peers || []).forEach((p) => {
      if (p.disabled) return;
      const ip = tunnelToHost(p.tunnel_ip);
      if (!ip) return;
      const o = document.createElement("option");
      o.value = ip;
      o.textContent = ip + " (" + p.name + ")";
      sel.appendChild(o);
    });
  }

  function tunnelToHost(tip) {
    tip = String(tip || "").trim();
    const m = tip.match(/^([\d.]+)(?:\/\d+)?$/);
    return m ? m[1] : "";
  }

  function routeProtoFromCheckboxes() {
    const tcp = $("route-f-proto-tcp").checked;
    const udp = $("route-f-proto-udp").checked;
    if (tcp && udp) return "tcp,udp";
    if (tcp) return "tcp";
    if (udp) return "udp";
    return "";
  }

  function setRouteProtoCheckboxes(protoStr) {
    const s = String(protoStr || "").toLowerCase().trim();
    let tcp = false;
    let udp = false;
    if (s === "both") {
      tcp = true;
      udp = true;
    } else {
      const parts = s.split(/[,+\s]+/).map((x) => x.trim()).filter(Boolean);
      tcp = s === "tcp" || parts.includes("tcp");
      udp = s === "udp" || parts.includes("udp");
    }
    $("route-f-proto-tcp").checked = tcp;
    $("route-f-proto-udp").checked = udp;
  }

  function formatRouteProtoCell(p) {
    const raw = String(p || "").trim();
    if (!raw) return "—";
    const s = raw.toLowerCase();
    if (s === "both") return "tcp, udp";
    const parts = s.split(/[,+\s]+/).map((x) => x.trim()).filter(Boolean);
    const tcp = s === "tcp" || parts.includes("tcp");
    const udp = s === "udp" || parts.includes("udp");
    if (tcp && udp) return "tcp, udp";
    if (tcp) return "tcp";
    if (udp) return "udp";
    return escapeHtml(raw);
  }

  function renderRoutesTable(cfg) {
    const wrap = $("routes-table-wrap");
    const routes = (cfg.forwarding && cfg.forwarding.routes) || [];

    if (!routes.length) {
      wrap.innerHTML = "<p class=\"hint\">No routes yet. Add one or edit <code class=\"inline\">forwarding.routes</code> in config.</p>";
      return;
    }
    const rows = routes
      .map(
        (r, i) =>
          `<tr><td>${formatRouteProtoCell(r.proto)}</td><td class="mono">${escapeHtml((r.ports || []).join(", "))}</td><td class="mono">${escapeHtml(r.target_ip)}</td>${tableDisabledToggleCell("data-route-disabled", i, !!r.disabled, "Enabled: route to " + String(r.target_ip || ""))}<td class="row-actions"><button type="button" data-route-edit="${i}">Edit</button> <button type="button" data-route-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      )
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Ports</th><th>Target</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll("[data-route-edit]").forEach((b) => {
      b.addEventListener("click", () => openRouteEditor(+b.getAttribute("data-route-edit")));
    });
    wrap.querySelectorAll("[data-route-del]").forEach((b) => {
      b.addEventListener("click", () => removeRoute(+b.getAttribute("data-route-del")));
    });
    wrap.querySelectorAll("input[data-route-disabled]").forEach((inp) => {
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      inp.addEventListener("change", async () => {
        const idx = +inp.getAttribute("data-route-disabled");
        await patchRouteDisabled(idx, !inp.checked);
      });
    });
  }

  function openRouteEditor(index) {
    const cfg = lastConfig;
    if (!cfg) return;
    if (!cfg.forwarding.routes) cfg.forwarding.routes = [];
    peerTunnelIPv4Options(cfg);
    const dis = $("route-f-disabled");
    if (dis) dis.checked = true;
    if (index === -1) {
      $("route-edit-index").value = "";
      $("route-editor-title").textContent = "Add route";
      setRouteProtoCheckboxes("tcp");
      $("route-f-ports").value = "";
    } else {
      const r = cfg.forwarding.routes[index];
      if (!r) return;
      $("route-edit-index").value = String(index);
      $("route-editor-title").textContent = "Edit route";
      setRouteProtoCheckboxes(r.proto);
      $("route-f-ports").value = (r.ports || []).join(", ");
      $("route-f-target").value = r.target_ip || "";
      if (dis) dis.checked = !r.disabled;
    }
    const modal = $("route-modal");
    if (modal) {
      modal.classList.remove("is-hidden");
      const firstFocus = $("route-f-proto-tcp");
      if (firstFocus) requestAnimationFrame(() => firstFocus.focus());
    }
  }

  function closeRouteEditor() {
    const modal = $("route-modal");
    if (modal) modal.classList.add("is-hidden");
  }

  function parsePortsList(s) {
    return s
      .split(/[,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  async function saveRouteEditor() {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.forwarding) cfg.forwarding = {};
    if (!cfg.forwarding.routes) cfg.forwarding.routes = [];
    const proto = routeProtoFromCheckboxes();
    const ports = parsePortsList($("route-f-ports").value);
    const target = $("route-f-target").value.trim();
    if (!proto) {
      setRoutesMsg("Select at least one protocol (TCP and/or UDP).", true);
      return;
    }
    if (!ports.length || !target) {
      setRoutesMsg("Ports and target are required.", true);
      return;
    }
    const routeEn = $("route-f-disabled");
    const entry = { proto, ports, target_ip: target, disabled: !(routeEn && routeEn.checked) };
    const idxRaw = $("route-edit-index").value;
    if (idxRaw === "") cfg.forwarding.routes.push(entry);
    else cfg.forwarding.routes[+idxRaw] = entry;
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setRoutesMsg("Routes saved. Open Pending changes to review nftables, then Apply to host.");
      closeRouteEditor();
      renderRoutesTable(cfg);
      setApiStatus(true);
      refreshPendingBadge();
    } catch (e) {
      setRoutesMsg(String(e.message || e), true);
    }
  }

  async function removeRoute(index) {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.forwarding || !cfg.forwarding.routes) return;
    cfg.forwarding.routes.splice(index, 1);
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setRoutesMsg("Route removed from config. Apply on Pending changes when ready.");
      renderRoutesTable(cfg);
      setApiStatus(true);
      refreshPendingBadge();
    } catch (e) {
      setRoutesMsg(String(e.message || e), true);
    }
  }

  async function refreshRoutesPage() {
    setRoutesMsg("");
    try {
      lastConfig = await api("/v1/config");
      setApiStatus(true);
      renderRoutesTable(lastConfig);
      peerTunnelIPv4Options(lastConfig);
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setRoutesMsg(String(e.message || e), true);
    }
  }

  /* ——— Inbound access (input_allows) ——— */
  function setInboundMsg(text, isErr) {
    const el = $("inbound-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  function renderInboundTable(cfg) {
    const wrap = $("inbound-table-wrap");
    if (!wrap) return;
    const rules = cfg.input_allows || [];

    if (!rules.length) {
      wrap.innerHTML =
        "<p class=\"hint\">No extra INPUT rules. Add one for SSH, HTTP, or other host services (<code class=\"inline\">input_allows</code>).</p>";
      return;
    }
    const rows = rules
      .map((r, i) => {
        const aria =
          "Enabled: INPUT " +
          String(r.proto || "").toLowerCase() +
          " " +
          String(r.dport || r.note || "#" + i);
        return (
          `<tr><td class="mono">${escapeHtml(String(r.proto || "").toLowerCase())}</td><td class="mono">${escapeHtml(r.dport || "")}</td><td>${escapeHtml(r.note || "—")}</td>${tableDisabledToggleCell("data-inbound-disabled", i, !!r.disabled, aria)}<td class="row-actions"><button type="button" data-inbound-edit="${i}">Edit</button> <button type="button" data-inbound-del="${i}" class="btn-quiet">Remove</button></td></tr>`
        );
      })
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Port(s)</th><th>Note</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll("[data-inbound-edit]").forEach((b) => {
      b.addEventListener("click", () => openInboundEditor(+b.getAttribute("data-inbound-edit")));
    });
    wrap.querySelectorAll("[data-inbound-del]").forEach((b) => {
      b.addEventListener("click", () => removeInboundRule(+b.getAttribute("data-inbound-del")));
    });
    wrap.querySelectorAll("input[data-inbound-disabled]").forEach((inp) => {
      inp.addEventListener("click", (ev) => ev.stopPropagation());
      inp.addEventListener("change", async () => {
        const idx = +inp.getAttribute("data-inbound-disabled");
        const wantEnabled = inp.checked;
        if (wantEnabled) {
          const r = (lastConfig.input_allows || [])[idx];
          if (!r || !String(r.dport || "").trim()) {
            setInboundMsg("Add a destination port in Edit before enabling this rule.", true);
            inp.checked = false;
            return;
          }
        }
        await patchInboundDisabled(idx, !wantEnabled);
      });
    });
  }

  function openInboundEditor(index) {
    const cfg = lastConfig;
    if (!cfg) return;
    if (!cfg.input_allows) cfg.input_allows = [];
    const protoSel = $("inbound-f-proto");
    const dport = $("inbound-f-dport");
    const note = $("inbound-f-note");
    if (!protoSel || !dport || !note) return;

    const disInp = $("inbound-f-disabled");
    if (index === -1) {
      $("inbound-edit-index").value = "";
      $("inbound-editor-title").textContent = "Add rule";
      protoSel.value = "tcp";
      dport.value = "";
      note.value = "";
      if (disInp) disInp.checked = true;
    } else {
      const r = cfg.input_allows[index];
      if (!r) return;
      $("inbound-edit-index").value = String(index);
      $("inbound-editor-title").textContent = "Edit rule";
      const p = String(r.proto || "tcp").toLowerCase();
      protoSel.value = p === "udp" ? "udp" : "tcp";
      dport.value = r.dport || "";
      note.value = r.note || "";
      if (disInp) disInp.checked = !r.disabled;
    }
    const modal = $("inbound-modal");
    if (modal) {
      modal.classList.remove("is-hidden");
      requestAnimationFrame(() => dport.focus());
    }
  }

  function closeInboundEditor() {
    const modal = $("inbound-modal");
    if (modal) modal.classList.add("is-hidden");
  }

  async function saveInboundEditor() {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.input_allows) cfg.input_allows = [];
    const proto = ($("inbound-f-proto").value || "tcp").toLowerCase();
    const dport = $("inbound-f-dport").value.trim();
    const note = $("inbound-f-note").value.trim();
    if (proto !== "tcp" && proto !== "udp") {
      setInboundMsg("Protocol must be tcp or udp.", true);
      return;
    }
    const disEl = $("inbound-f-disabled");
    const enabled = disEl && disEl.checked;
    if (enabled && !dport) {
      setInboundMsg("Destination port is required.", true);
      return;
    }
    const entry = { proto };
    if (dport) entry.dport = dport;
    if (note) entry.note = note;
    entry.disabled = !enabled;
    const idxRaw = $("inbound-edit-index").value;
    if (idxRaw === "") cfg.input_allows.push(entry);
    else cfg.input_allows[+idxRaw] = entry;
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setInboundMsg("Saved. Open Pending changes to review nftables, then Apply to host.");
      closeInboundEditor();
      renderInboundTable(cfg);
      setApiStatus(true);
      refreshPendingBadge();
    } catch (e) {
      setInboundMsg(String(e.message || e), true);
    }
  }

  async function removeInboundRule(index) {
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.input_allows) return;
    cfg.input_allows.splice(index, 1);
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setInboundMsg("Rule removed. Apply on Pending changes when ready.");
      renderInboundTable(cfg);
      setApiStatus(true);
      refreshPendingBadge();
    } catch (e) {
      setInboundMsg(String(e.message || e), true);
    }
  }

  async function refreshInboundPage() {
    setInboundMsg("");
    try {
      lastConfig = await api("/v1/config");
      setApiStatus(true);
      renderInboundTable(lastConfig);
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setInboundMsg(String(e.message || e), true);
    }
  }

  /* ——— Geoblocking ——— */
  let geoCountryCatalog = null;
  /** @type {Map<string, { code: string, name: string }>} */
  let geoCountryByCode = new Map();
  let geoSelectedCodes = [];
  /** @type {Set<string>} */
  let geoModalDraft = new Set();

  function setGeoMsg(text, isErr) {
    const el = $("geo-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  function countryFlagEmoji(code) {
    const c = String(code || "")
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    if (c.length !== 2) return "";
    const cp = (ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65);
    return String.fromCodePoint(cp(c[0]), cp(c[1]));
  }

  async function loadGeoCountryCatalog() {
    if (geoCountryCatalog) return;
    const base = typeof window.EVUPROXY_STATIC === "string" ? window.EVUPROXY_STATIC : "/static";
    const r = await fetch(base + "/geo-countries.json", { credentials: "same-origin" });
    if (!r.ok) throw new Error("Could not load country list (" + r.status + ").");
    const raw = await r.json();
    geoCountryCatalog = raw
      .map((x) => ({
        code: String(x["alpha-2"] || "")
          .trim()
          .toLowerCase(),
        name: String(x.name || "").trim() || String(x["alpha-2"] || ""),
      }))
      .filter((x) => x.code.length === 2);
    geoCountryByCode = new Map(geoCountryCatalog.map((x) => [x.code, x]));
    geoCountryCatalog.sort((a, b) => a.name.localeCompare(b.name));
  }

  function geoCountryName(code) {
    const c = String(code || "").toLowerCase();
    const row = geoCountryByCode.get(c);
    return row ? row.name : c.toUpperCase();
  }

  function getGeoListMode() {
    const allowBtn = $("geo-mode-allow");
    return allowBtn && allowBtn.classList.contains("is-active") ? "allow" : "block";
  }

  function setGeoListMode(mode) {
    const m = mode === "block" ? "block" : "allow";
    const blockBtn = $("geo-mode-block");
    const allowBtn = $("geo-mode-allow");
    if (blockBtn) {
      blockBtn.classList.toggle("is-active", m === "block");
      blockBtn.setAttribute("aria-pressed", m === "block" ? "true" : "false");
    }
    if (allowBtn) {
      allowBtn.classList.toggle("is-active", m === "allow");
      allowBtn.setAttribute("aria-pressed", m === "allow" ? "true" : "false");
    }
    const ex = $("geo-mode-explainer");
    if (ex) {
      ex.textContent =
        m === "allow"
          ? "Listed countries may reach public ports; others are dropped (logged)."
          : "Listed countries are blocked from public ports; others are allowed.";
    }
    const hint = $("geo-modal-hint");
    if (hint && !hint.closest(".is-hidden")) {
      hint.textContent =
        m === "allow"
          ? "Check countries to allow. Search filters the list."
          : "Check countries to block. Search filters the list.";
    }
  }

  function updateGeoTagsEditCount() {
    const n = $("geo-tags-edit-count");
    if (n) n.textContent = "(" + geoSelectedCodes.length + ")";
  }

  function renderGeoTags() {
    const box = $("geo-tags-chips");
    if (!box) return;
    box.innerHTML = "";
    const sorted = geoSelectedCodes.slice().sort((a, b) => geoCountryName(a).localeCompare(geoCountryName(b)));
    for (const code of sorted) {
      const fl = countryFlagEmoji(code);
      const tag = document.createElement("span");
      tag.className = "geo-tag";
      tag.innerHTML =
        '<span class="geo-tag-flag" aria-hidden="true">' +
        escapeHtml(fl || "·") +
        "</span>" +
        '<span class="geo-tag-name">' +
        escapeHtml(geoCountryName(code)) +
        "</span>";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "geo-tag-remove";
      rm.setAttribute("aria-label", "Remove " + geoCountryName(code));
      rm.textContent = "×";
      rm.addEventListener("click", () => {
        geoSelectedCodes = geoSelectedCodes.filter((c) => c !== code);
        updateGeoTagsEditCount();
        renderGeoTags();
      });
      tag.appendChild(rm);
      box.appendChild(tag);
    }
    updateGeoTagsEditCount();
  }

  function geoFormFromConfig(cfg) {
    const g = (cfg && cfg.geo) || {};
    const en = $("geo-f-enabled");
    const sn = $("geo-f-set-name");
    const zd = $("geo-f-zone-dir");
    if (en) en.checked = !!g.enabled;
    if (sn) sn.value = g.set_name || "";
    if (zd) zd.value = g.zone_dir || "";
    const mode = String(g.mode || "allow").toLowerCase() === "block" ? "block" : "allow";
    setGeoListMode(mode);
    geoSelectedCodes = Array.isArray(g.countries)
      ? g.countries.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    renderGeoTags();
  }

  function openGeoCountryModal() {
    const modal = $("geo-country-modal");
    if (!modal) return;
    geoModalDraft = new Set(geoSelectedCodes);
    const hint = $("geo-modal-hint");
    if (hint) {
      hint.textContent =
        getGeoListMode() === "allow"
          ? "Check countries to allow. Search filters the list."
          : "Check countries to block. Search filters the list.";
    }
    const search = $("geo-modal-search");
    if (search) search.value = "";
    renderGeoModalList("");
    modal.classList.remove("is-hidden");
    const edit = $("geo-tags-edit");
    if (edit) {
      edit.setAttribute("aria-expanded", "true");
    }
    if (search) requestAnimationFrame(() => search.focus());
  }

  function closeGeoCountryModal() {
    const modal = $("geo-country-modal");
    if (modal) modal.classList.add("is-hidden");
    const edit = $("geo-tags-edit");
    if (edit) edit.setAttribute("aria-expanded", "false");
  }

  function renderGeoModalList(filterRaw) {
    const list = $("geo-modal-list");
    if (!list || !geoCountryCatalog) return;
    const q = String(filterRaw || "")
      .trim()
      .toLowerCase();
    const rows = [];
    for (const row of geoCountryCatalog) {
      if (q) {
        const hay = (row.code + " " + row.name).toLowerCase();
        if (!hay.includes(q)) continue;
      }
      const checked = geoModalDraft.has(row.code);
      const fl = countryFlagEmoji(row.code);
      rows.push(
        '<label class="geo-modal-row">' +
          '<input type="checkbox" data-geo-code="' +
          escapeHtml(row.code) +
          '" ' +
          (checked ? "checked " : "") +
          "/>" +
          '<span class="geo-modal-row-flag" aria-hidden="true">' +
          escapeHtml(fl || "·") +
          "</span>" +
          '<span class="geo-modal-row-name">' +
          escapeHtml(row.name) +
          "</span>" +
          "</label>"
      );
    }
    list.innerHTML = rows.length ? rows.join("") : '<p class="hint meta" style="padding:0.75rem">No matches.</p>';
    list.querySelectorAll('input[type="checkbox"][data-geo-code]').forEach((inp) => {
      inp.addEventListener("change", () => {
        const code = inp.getAttribute("data-geo-code");
        if (!code) return;
        if (inp.checked) geoModalDraft.add(code);
        else geoModalDraft.delete(code);
      });
    });
  }

  async function saveGeoblocking() {
    if (!lastConfig) return;
    const cfg = JSON.parse(JSON.stringify(lastConfig));
    if (!cfg.geo) cfg.geo = {};
    const g = cfg.geo;
    g.enabled = $("geo-f-enabled") && $("geo-f-enabled").checked;
    g.mode = getGeoListMode();
    g.countries = geoSelectedCodes.slice().map((c) => c.toLowerCase());
    g.set_name = ($("geo-f-set-name") && $("geo-f-set-name").value.trim()) || "";
    g.zone_dir = ($("geo-f-zone-dir") && $("geo-f-zone-dir").value.trim()) || "";
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setGeoMsg("Saved. Review Pending changes, then Apply to host.");
      setApiStatus(true);
      refreshPendingBadge();
    } catch (e) {
      setGeoMsg(String(e.message || e), true);
    }
  }

  async function refreshGeoblockingPage() {
    setGeoMsg("");
    try {
      await loadGeoCountryCatalog();
      lastConfig = await api("/v1/config");
      setApiStatus(true);
      geoFormFromConfig(lastConfig);
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setGeoMsg(String(e.message || e), true);
    }
    syncGeoAdvancedFieldsVisibility();
  }

  async function geoUpdateLists() {
    setGeoMsg("…");
    try {
      await api("/v1/update-geo", { method: "POST" });
      setGeoMsg("Geo lists updated on host.");
      setApiStatus(true);
    } catch (e) {
      setGeoMsg(String(e.message || e), true);
    }
  }

  function setPendingMsg(text, isErr) {
    const el = $("pending-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  const PENDING_DIFF_MODE_KEY = "evuproxy_pending_diff_mode";
  /** Production nftables can be much larger than dev mocks; cap limits memory (~lcsLen + dirs). */
  const LINE_DIFF_MAX_CELLS = 12_000_000;
  const LINE_DIFF_MAX_SIDE = 6000;
  const CHAR_DIFF_MAX_CELLS = 500_000;
  const CHAR_DIFF_MAX_LEN = 4096;

  let lastPendingBaseline = "";
  let lastPendingNew = "";

  function getPendingDiffMode() {
    try {
      const m = sessionStorage.getItem(PENDING_DIFF_MODE_KEY);
      if (m === "split" || m === "unified") return m;
    } catch (e) {
      /* ignore */
    }
    return "unified";
  }

  function setPendingDiffMode(mode) {
    try {
      sessionStorage.setItem(PENDING_DIFF_MODE_KEY, mode);
    } catch (e) {
      /* ignore */
    }
  }

  function splitLines(text) {
    if (text.length === 0) return [];
    return String(text).replace(/\r\n/g, "\n").split("\n");
  }

  function mergeCharOps(ops) {
    const merged = [];
    for (const op of ops) {
      const last = merged[merged.length - 1];
      if (last && last.type === op.type) {
        last.text += op.text;
      } else {
        merged.push({ type: op.type, text: op.text });
      }
    }
    return merged;
  }

  function computeLineDiff(oldLines, newLines) {
    const m = oldLines.length;
    const n = newLines.length;
    if (m > LINE_DIFF_MAX_SIDE || n > LINE_DIFF_MAX_SIDE || m * n > LINE_DIFF_MAX_CELLS) {
      return null;
    }
    try {
      const cols = n + 1;
      const idx = (i, j) => i * cols + j;
      const lcsLen = new Uint32Array((m + 1) * (n + 1));
      const dirs = new Int8Array((m + 1) * (n + 1));
      for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
          if (oldLines[i - 1] === newLines[j - 1]) {
            lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j - 1)] + 1;
            dirs[idx(i, j)] = 1;
          } else if (lcsLen[idx(i - 1, j)] >= lcsLen[idx(i, j - 1)]) {
            lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j)];
            dirs[idx(i, j)] = 2;
          } else {
            lcsLen[idx(i, j)] = lcsLen[idx(i, j - 1)];
            dirs[idx(i, j)] = 3;
          }
        }
      }
      const ops = [];
      let i = m;
      let j = n;
      while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && dirs[idx(i, j)] === 1) {
          ops.unshift({ type: "equal", oldLine: oldLines[i - 1], newLine: newLines[j - 1] });
          i--;
          j--;
        } else if (j > 0 && (i === 0 || dirs[idx(i, j)] === 3)) {
          ops.unshift({ type: "insert", line: newLines[j - 1] });
          j--;
        } else if (i > 0) {
          ops.unshift({ type: "delete", line: oldLines[i - 1] });
          i--;
        } else {
          break;
        }
      }
      return ops;
    } catch (e) {
      return null;
    }
  }

  function computeCharDiff(oldStr, newStr) {
    const a = oldStr.split("");
    const b = newStr.split("");
    const m = a.length;
    const n = b.length;
    if (m > CHAR_DIFF_MAX_LEN || n > CHAR_DIFF_MAX_LEN || m * n > CHAR_DIFF_MAX_CELLS) {
      return null;
    }
    const cols = n + 1;
    const idx = (i, j) => i * cols + j;
    const lcsLen = new Uint32Array((m + 1) * (n + 1));
    const dirs = new Int8Array((m + 1) * (n + 1));
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j - 1)] + 1;
          dirs[idx(i, j)] = 1;
        } else if (lcsLen[idx(i - 1, j)] >= lcsLen[idx(i, j - 1)]) {
          lcsLen[idx(i, j)] = lcsLen[idx(i - 1, j)];
          dirs[idx(i, j)] = 2;
        } else {
          lcsLen[idx(i, j)] = lcsLen[idx(i, j - 1)];
          dirs[idx(i, j)] = 3;
        }
      }
    }
    const raw = [];
    let i = m;
    let j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && dirs[idx(i, j)] === 1) {
        raw.unshift({ type: "equal", text: a[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dirs[idx(i, j)] === 3)) {
        raw.unshift({ type: "insert", text: b[j - 1] });
        j--;
      } else if (i > 0) {
        raw.unshift({ type: "delete", text: a[i - 1] });
        i--;
      } else {
        break;
      }
    }
    return mergeCharOps(raw);
  }

  function intralinePairHtml(oldLine, newLine) {
    if (oldLine === newLine) {
      const e = escapeHtml(oldLine);
      return { delHtml: e, insHtml: e };
    }
    if (!oldLine) {
      return {
        delHtml: "",
        insHtml: `<span class="diff-ch-strong diff-ch-ins">${escapeHtml(newLine)}</span>`,
      };
    }
    if (!newLine) {
      return {
        delHtml: `<span class="diff-ch-strong diff-ch-del">${escapeHtml(oldLine)}</span>`,
        insHtml: "",
      };
    }
    const ops = computeCharDiff(oldLine, newLine);
    if (!ops) {
      return { delHtml: escapeHtml(oldLine), insHtml: escapeHtml(newLine) };
    }
    let delH = "";
    let insH = "";
    for (const op of ops) {
      if (op.type === "equal") {
        const e = escapeHtml(op.text);
        delH += e;
        insH += e;
      } else if (op.type === "delete") {
        delH += `<span class="diff-ch-strong diff-ch-del">${escapeHtml(op.text)}</span>`;
      } else {
        insH += `<span class="diff-ch-strong diff-ch-ins">${escapeHtml(op.text)}</span>`;
      }
    }
    return { delHtml: delH, insHtml: insH };
  }

  function renderUnifiedDiffHtml(ops) {
    const rows = [];
    let oldNum = 0;
    let newNum = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === "equal") {
        oldNum++;
        newNum++;
        rows.push(
          `<tr class="diff-row-ctx"><td class="diff-ln">${oldNum}</td><td class="diff-ln">${newNum}</td><td class="diff-sign"></td><td class="diff-code">${escapeHtml(
            op.oldLine
          )}</td></tr>`
        );
        continue;
      }
      if (op.type === "delete") {
        const next = ops[i + 1];
        if (next && next.type === "insert") {
          const { delHtml, insHtml } = intralinePairHtml(op.line, next.line);
          oldNum++;
          rows.push(
            `<tr class="diff-row-diff-del"><td class="diff-ln">${oldNum}</td><td class="diff-ln"></td><td class="diff-sign">-</td><td class="diff-code">${delHtml}</td></tr>`
          );
          newNum++;
          rows.push(
            `<tr class="diff-row-diff-ins"><td class="diff-ln"></td><td class="diff-ln">${newNum}</td><td class="diff-sign">+</td><td class="diff-code">${insHtml}</td></tr>`
          );
          i++;
          continue;
        }
        oldNum++;
        rows.push(
          `<tr class="diff-row-diff-del"><td class="diff-ln">${oldNum}</td><td class="diff-ln"></td><td class="diff-sign">-</td><td class="diff-code">${escapeHtml(
            op.line
          )}</td></tr>`
        );
        continue;
      }
      if (op.type === "insert") {
        newNum++;
        rows.push(
          `<tr class="diff-row-diff-ins"><td class="diff-ln"></td><td class="diff-ln">${newNum}</td><td class="diff-sign">+</td><td class="diff-code">${escapeHtml(
            op.line
          )}</td></tr>`
        );
      }
    }
    return `<div class="pending-diff-scroll"><table class="pending-diff-unified"><tbody>${rows.join("")}</tbody></table></div>`;
  }

  function renderSplitDiffHtml(ops) {
    /** Keeps row height aligned between the two independent tables (empty td can collapse). */
    const padCell = '<td class="diff-split-ln"></td><td class="diff-split-code diff-split-pad">&nbsp;</td>';
    const leftRows = [];
    const rightRows = [];
    let oldNum = 0;
    let newNum = 0;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.type === "equal") {
        oldNum++;
        newNum++;
        leftRows.push(
          `<tr class="diff-split-row diff-split-row-ctx"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${escapeHtml(
            op.oldLine
          )}</td></tr>`
        );
        rightRows.push(
          `<tr class="diff-split-row diff-split-row-ctx"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${escapeHtml(
            op.newLine
          )}</td></tr>`
        );
        continue;
      }
      if (op.type === "delete") {
        const next = ops[i + 1];
        if (next && next.type === "insert") {
          const { delHtml, insHtml } = intralinePairHtml(op.line, next.line);
          oldNum++;
          newNum++;
          leftRows.push(
            `<tr class="diff-split-row diff-split-row-both-l"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${delHtml}</td></tr>`
          );
          rightRows.push(
            `<tr class="diff-split-row diff-split-row-both-r"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${insHtml}</td></tr>`
          );
          i++;
          continue;
        }
        oldNum++;
        leftRows.push(
          `<tr class="diff-split-row diff-split-row-del"><td class="diff-split-ln">${oldNum}</td><td class="diff-split-code">${escapeHtml(
            op.line
          )}</td></tr>`
        );
        rightRows.push(`<tr class="diff-split-row diff-split-row-gap">${padCell}</tr>`);
        continue;
      }
      if (op.type === "insert") {
        newNum++;
        leftRows.push(`<tr class="diff-split-row diff-split-row-gap">${padCell}</tr>`);
        rightRows.push(
          `<tr class="diff-split-row diff-split-row-ins"><td class="diff-split-ln">${newNum}</td><td class="diff-split-code">${escapeHtml(
            op.line
          )}</td></tr>`
        );
      }
    }
    return (
      `<div class="pending-diff-split-view">` +
      `<div class="pending-diff-split-pane" data-pending-split-pane="left" tabindex="-1"><table class="pending-diff-split-side"><tbody>${leftRows.join(
        ""
      )}</tbody></table></div>` +
      `<div class="pending-diff-split-pane" data-pending-split-pane="right" tabindex="-1"><table class="pending-diff-split-side"><tbody>${rightRows.join(
        ""
      )}</tbody></table></div>` +
      `</div>`
    );
  }

  /** Link vertical scroll between split panes; horizontal scroll stays independent per pane. */
  function setupPendingSplitScrollSync(panel) {
    const view = panel && panel.querySelector(".pending-diff-split-view");
    if (!view) return;
    const panes = view.querySelectorAll(".pending-diff-split-pane");
    if (panes.length !== 2) return;
    const left = panes[0];
    const right = panes[1];
    let lock = false;
    function syncFrom(src, dst) {
      if (lock) return;
      if (dst.scrollTop === src.scrollTop) return;
      lock = true;
      dst.scrollTop = src.scrollTop;
      lock = false;
    }
    left.addEventListener("scroll", () => syncFrom(left, right), { passive: true });
    right.addEventListener("scroll", () => syncFrom(right, left), { passive: true });
  }

  function renderPendingDiffTooLarge(oldText, newText, mode, oldLineCount, newLineCount) {
    const lc =
      oldLineCount != null && newLineCount != null
        ? ` (${oldLineCount} vs ${newLineCount} lines — product exceeds browser limit).`
        : ".";
    const hint =
      `<p class="hint pending-diff-same">Diff too large to compute in the browser${lc} Showing full texts below; use an external diff if you need line-level detail.</p>`;
    if (mode === "split") {
      return (
        hint +
        `<div class="pending-diff-split-view">` +
        `<div class="pending-diff-split-pane" data-pending-split-pane="left" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(oldText)}</pre></div>` +
        `<div class="pending-diff-split-pane" data-pending-split-pane="right" tabindex="-1"><pre class="code-block pending-raw-diff-pre" tabindex="0">${escapeHtml(newText)}</pre></div>` +
        `</div>`
      );
    }
    return (
      hint +
      `<h4 class="pending-diff-raw-h">Baseline (<code>generated/nftables.nft</code>)</h4>` +
      `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(oldText)}</pre>` +
      `<h4 class="pending-diff-raw-h">Proposed (current saved config)</h4>` +
      `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(newText)}</pre>`
    );
  }

  function renderPendingDiffPanel() {
    const panel = $("pending-diff-panel");
    const uBtn = $("pending-mode-unified");
    const sBtn = $("pending-mode-split");
    if (!panel) return;
    const mode = getPendingDiffMode();
    if (uBtn && sBtn) {
      uBtn.classList.toggle("is-active", mode === "unified");
      sBtn.classList.toggle("is-active", mode === "split");
      uBtn.setAttribute("aria-selected", mode === "unified" ? "true" : "false");
      sBtn.setAttribute("aria-selected", mode === "split" ? "true" : "false");
    }
    panel.setAttribute("aria-labelledby", mode === "unified" ? "pending-mode-unified" : "pending-mode-split");
    const oldText = lastPendingBaseline;
    const newText = lastPendingNew;
    const baselineHint =
      oldText === "" && newText !== ""
        ? `<p class="hint pending-diff-baseline-missing">No readable on-disk <code class="inline">generated/nftables.nft</code> (missing, unreadable, or API older than baseline support). The left column compares against an empty baseline; reload the host after a successful apply to populate the file.</p>`
        : "";
    if (oldText === newText) {
      let body = `<p class="hint pending-diff-same">No differences.</p>`;
      if (newText) {
        body += `<pre class="code-block pending-nft-pre" tabindex="0">${escapeHtml(newText)}</pre>`;
      }
      panel.innerHTML = body;
      return;
    }
    const oldLines = splitLines(oldText);
    const newLines = splitLines(newText);
    const ops = computeLineDiff(oldLines, newLines);
    if (!ops) {
      panel.innerHTML =
        baselineHint + renderPendingDiffTooLarge(oldText, newText, mode, oldLines.length, newLines.length);
      if (mode === "split") setupPendingSplitScrollSync(panel);
      return;
    }
    if (mode === "split") {
      panel.innerHTML = baselineHint + renderSplitDiffHtml(ops);
      setupPendingSplitScrollSync(panel);
    } else {
      panel.innerHTML = baselineHint + renderUnifiedDiffHtml(ops);
    }
  }

  async function refreshPendingBadge() {
    const dot = $("nav-pending-dot");
    if (!dot) return;
    try {
      const p = await api("/v1/pending");
      dot.classList.toggle("is-hidden", !p.pending);
      dot.title = p.pending ? "Saved config not yet applied to host" : "";
    } catch {
      dot.classList.add("is-hidden");
    }
  }

  async function refreshPendingPage() {
    const status = $("pending-status");
    const panel = $("pending-diff-panel");
    if (!status || !panel) return;
    setPendingMsg("");
    try {
      const p = await api("/v1/pending");
      setApiStatus(true);
      if (p.pending) {
        status.textContent =
          "Unapplied changes: the saved config on disk differs from the last successful reload (nftables / WireGuard).";
        status.classList.remove("pending-no");
        status.classList.add("pending-yes");
      } else {
        status.textContent =
          "No pending changes. Saved config matches what was last applied on the host.";
        status.classList.remove("pending-yes");
        status.classList.add("pending-no");
      }
      lastPendingBaseline = p.nftables_baseline != null ? String(p.nftables_baseline) : "";
      lastPendingNew = p.nftables != null ? String(p.nftables) : "";
      const discardBtn = $("pending-discard");
      if (discardBtn) discardBtn.disabled = !p.discard_available;
      const restoreBtn = $("pending-restore-previous");
      if (restoreBtn) restoreBtn.disabled = !p.restore_previous_applied_available;
      renderPendingDiffPanel();
    } catch (e) {
      status.textContent = "";
      status.classList.remove("pending-yes", "pending-no");
      lastPendingBaseline = "";
      lastPendingNew = "";
      const discardErr = $("pending-discard");
      if (discardErr) discardErr.disabled = true;
      const restoreErr = $("pending-restore-previous");
      if (restoreErr) restoreErr.disabled = true;
      panel.innerHTML = "";
      setApiStatus(false, String(e.message || e));
      setPendingMsg(String(e.message || e), true);
    }
  }

  /* ——— Stats ——— */
  function setStatsMsg(text, isErr) {
    const el = $("stats-msg");
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  function fmtHandshake(u) {
    if (!u) return "never";
    const d = new Date(u * 1000);
    return isNaN(d.getTime()) ? String(u) : d.toISOString();
  }

  async function refreshStatsPage() {
    const wgW = $("stats-wg-wrap");
    const nftW = $("stats-nft-wrap");
    setStatsMsg("");
    try {
      const st = await api("/v1/stats");
      setApiStatus(true);
      if (st.wireguard_dump_failed) {
        wgW.innerHTML =
          "<p class=\"hint\">WireGuard stats unavailable (<code>wg show</code> failed — interface missing, permission denied, or tools not installed).</p>";
      } else if (st.wireguard_peers && st.wireguard_peers.length) {
        const rows = st.wireguard_peers
          .map(
            (p) =>
              `<tr><td class="mono">${escapeHtml(trunc(p.public_key, 24))}</td><td>${escapeHtml(p.endpoint || "—")}</td><td class="mono">${escapeHtml(fmtHandshake(p.latest_handshake_unix))}</td><td>${p.transfer_rx} / ${p.transfer_tx}</td></tr>`
          )
          .join("");
        wgW.innerHTML = `<table class="data"><thead><tr><th>Public key</th><th>Endpoint</th><th>Handshake</th><th>RX / TX</th></tr></thead><tbody>${rows}</tbody></table>`;
      } else {
        wgW.innerHTML = "<p class=\"hint\">No peers on this WireGuard interface (dump succeeded but no peer rows).</p>";
      }
      if (st.nftables_counters && st.nftables_counters.length) {
        const rows = st.nftables_counters
          .map(
            (r) =>
              `<tr><td>${escapeHtml(r.family)}</td><td>${escapeHtml(r.table)}</td><td>${r.packets}</td><td>${r.bytes}</td><td class="mono" style="max-width:24rem;word-break:break-all">${escapeHtml(r.line)}</td></tr>`
          )
          .join("");
        nftW.innerHTML = `<table class="data"><thead><tr><th>Family</th><th>Table</th><th>Packets</th><th>Bytes</th><th>Rule</th></tr></thead><tbody>${rows}</tbody></table>`;
      } else {
        nftW.innerHTML = "<p class=\"hint\">No nft counter lines (nft not available or empty).</p>";
      }
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setStatsMsg(String(e.message || e), true);
      wgW.innerHTML = "";
      nftW.innerHTML = "";
    }
  }

  /* ——— Logs ——— */
  function setLogsMsg(text, isErr) {
    const el = $("logs-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  async function refreshLogsPage() {
    const pre = $("logs-pre");
    const src = $("logs-source");
    setLogsMsg("");
    if (pre) pre.textContent = "";
    if (src) src.textContent = "";
    try {
      const j = await api("/v1/logs?limit=500");
      setApiStatus(true);
      if (src) {
        src.textContent = j.source ? "Source: " + j.source : "";
      }
      const lines = j.lines || [];
      if (pre) {
        pre.textContent = lines.length ? lines.join("\n") : "(no matching lines)";
      }
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      setLogsMsg(String(e.message || e), true);
    }
  }

  async function refreshSidebarAbout() {
    const el = $("sidebar-version");
    if (!el || el.dataset.loaded === "1") return;
    try {
      const a = await api("/v1/about");
      el.textContent = a.version || "—";
      el.dataset.loaded = "1";
    } catch {
      /* no token or API down */
    }
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

  const onboardInstallCmdPlaceholder =
    "Fill all peer fields and private key. Server details load from the API when you edit this form; the install command appears when everything is valid.";

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
    const o = lastOverview;
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

  function buildPeerInstallOneliner(p) {
    const q = shellSingleQuote;
    const url = peerInstallScriptUrl;
    return [
      "set -euo pipefail",
      "export EVUPROXY_WG_PRIVATE_KEY=" + q(p.priv),
      "export EVUPROXY_WG_ADDRESS=" + q(p.tip),
      "export EVUPROXY_WG_SERVER_PUBLIC_KEY=" + q(p.serverPublicKey),
      "export EVUPROXY_WG_ENDPOINT=" + q(p.ep),
      "export EVUPROXY_WG_ALLOWED_IPS=" + q(p.subnet),
      '_evu_script="$(mktemp)"',
      "trap 'rm -f \"$_evu_script\"' EXIT INT TERM",
      "curl -fsSL " + q(url) + ' -o "$_evu_script"',
      'sha256sum "$_evu_script"',
      "# Compare the hash to scripts/peer-install.sh in SHA256SUMS on the matching GitHub Release, then run:",
      'sudo -E bash "$_evu_script"',
 ].join("\n");
  }

  function refreshOnboardInstallCmd() {
    const pre = $("onboard-install-cmd");
    if (!pre) return;
    const r = peerOnboardWireGuardParams();
    if (!r.ok) {
      pre.textContent = onboardInstallCmdPlaceholder;
      return;
    }
    pre.textContent = buildPeerInstallOneliner(r);
  }

  async function copyOnboardInstallCmd() {
    const pre = $("onboard-install-cmd");
    if (!pre) return;
    const text = pre.textContent.trim();
    if (!text || text === onboardInstallCmdPlaceholder) {
      setOnboardMsg("Install command is not ready yet.", true);
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setOnboardMsg("Copied install command.");
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
    if (peerOverviewDebounceTimer) clearTimeout(peerOverviewDebounceTimer);
    peerOverviewDebounceTimer = setTimeout(() => {
      peerOverviewDebounceTimer = null;
      void fetchPeerOverviewForModal();
    }, 400);
  }

  async function fetchPeerOverviewForModal() {
    const pm = $("peer-modal");
    if (!pm || pm.classList.contains("is-hidden")) return;
    const seq = ++peerOverviewFetchSeq;
    try {
      const j = await api("/v1/overview");
      if (seq !== peerOverviewFetchSeq) return;
      lastOverview = j;
      updateServerHint(j);
      refreshOnboardInstallCmd();
    } catch (e) {
      if (seq !== peerOverviewFetchSeq) return;
      setOnboardMsg(String(e.message || e), true);
    }
  }

  /* ——— Init wiring ——— */
  document.querySelectorAll(".nav-link").forEach((a) => {
    a.addEventListener("click", (ev) => {
      if (a.classList.contains("nav-disabled")) {
        ev.preventDefault();
        return;
      }
      ev.preventDefault();
      void navigate(a.getAttribute("data-route"));
    });
  });
  window.addEventListener("hashchange", () => void onHash());

  const savedTok = localStorage.getItem(tokenKey);
  if (savedTok && $("token")) $("token").value = savedTok;
  const savedApiBase = localStorage.getItem(apiBaseKey);
  if ($("api-base") && savedApiBase != null && String(savedApiBase).trim() !== "") {
    $("api-base").value = String(savedApiBase).trim();
  }

  const advToggle = $("settings-advanced-toggle");
  if (advToggle) {
    advToggle.addEventListener("change", () => setAdvancedSettingsEnabled(advToggle.checked));
  }
  syncAdvancedSettingsToggle();

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

  $("settings-save-prefs").addEventListener("click", async () => {
    const cidrRaw = ($("peer-subnet-cidr") && $("peer-subnet-cidr").value.trim()) || "";
    const epRaw = ($("settings-wg-endpoint") && $("settings-wg-endpoint").value.trim()) || "";
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
    try {
      const p = await api("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify({
          peer_tunnel_subnet_cidr: cidrRaw,
          wireguard_server_endpoint: epRaw,
        }),
      });
      lastUIPrefs = {
        peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
        wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
      };
      if (msg) msg.textContent = "Preferences saved on server.";
      setApiStatus(true);
    } catch (e) {
      if (msg) {
        msg.textContent = String(e.message || e);
        msg.classList.add("err");
      }
      setApiStatus(false, String(e.message || e));
    }
  });

  $("btn-reload").addEventListener("click", async () => {
    setOverviewMsg("…");
    try {
      await api("/v1/reload", { method: "POST" });
      setOverviewMsg("Reload OK.");
      await refreshOverviewPage();
      refreshPendingBadge();
    } catch (e) {
      setOverviewMsg(String(e.message || e), true);
    }
  });
  $("btn-geo").addEventListener("click", async () => {
    setOverviewMsg("…");
    try {
      await api("/v1/update-geo", { method: "POST" });
      setOverviewMsg("Geo update OK.");
    } catch (e) {
      setOverviewMsg(String(e.message || e), true);
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

  $("peers-refresh").addEventListener("click", refreshPeersPage);
  $("peers-add-start").addEventListener("click", async () => {
    if (!lastConfig) return;
    $("peer-edit-index").value = "";
    $("peer-editor-title").textContent = "Add peer";
    $("peer-f-name").value = "";
    $("peer-f-tunnel").value = suggestedPeerTunnelIP(lastConfig);
    $("peer-f-pub").value = "";
    $("peer-f-disabled").checked = true;
    resetPeerOnboardExtras();
    const oe = $("onboard-endpoint");
    if (oe) oe.value = serverEndpointDisplay();
    const modal = $("peer-modal");
    if (modal) modal.classList.remove("is-hidden");
    try {
      const kp = await generatePeerKeypairBrowser();
      $("peer-f-pub").value = kp.publicKey;
      $("onboard-client-priv").value = kp.privateKey;
    } catch (e) {
      setPeersMsg(String(e.message || e), true);
    }
    refreshOnboardInstallCmd();
    void fetchPeerOverviewForModal();
    const first = $("peer-f-name");
    if (first) requestAnimationFrame(() => first.focus());
  });
  $("peer-save").addEventListener("click", savePeerEditor);
  $("peer-cancel").addEventListener("click", closePeerEditor);

  $("routes-refresh").addEventListener("click", refreshRoutesPage);
  $("routes-add").addEventListener("click", () => {
    if (!lastConfig) refreshRoutesPage().then(() => openRouteEditor(-1));
    else openRouteEditor(-1);
  });
  $("route-save").addEventListener("click", saveRouteEditor);
  $("route-cancel").addEventListener("click", closeRouteEditor);
  $("inbound-refresh").addEventListener("click", refreshInboundPage);
  $("inbound-add").addEventListener("click", () => {
    if (!lastConfig) refreshInboundPage().then(() => openInboundEditor(-1));
    else openInboundEditor(-1);
  });
  $("inbound-save").addEventListener("click", saveInboundEditor);
  $("inbound-cancel").addEventListener("click", closeInboundEditor);
  $("geo-save").addEventListener("click", saveGeoblocking);
  $("geo-refresh").addEventListener("click", refreshGeoblockingPage);
  $("geo-update-lists").addEventListener("click", geoUpdateLists);
  const geoModeBlock = $("geo-mode-block");
  const geoModeAllow = $("geo-mode-allow");
  if (geoModeBlock) {
    geoModeBlock.addEventListener("click", () => {
      setGeoListMode("block");
    });
  }
  if (geoModeAllow) {
    geoModeAllow.addEventListener("click", () => {
      setGeoListMode("allow");
    });
  }
  const geoTagsEdit = $("geo-tags-edit");
  if (geoTagsEdit) geoTagsEdit.addEventListener("click", openGeoCountryModal);
  const geoModalBackdrop = $("geo-modal-backdrop");
  if (geoModalBackdrop) geoModalBackdrop.addEventListener("click", closeGeoCountryModal);
  const geoModalCancel = $("geo-modal-cancel");
  if (geoModalCancel) geoModalCancel.addEventListener("click", closeGeoCountryModal);
  const geoModalSave = $("geo-modal-save");
  if (geoModalSave) {
    geoModalSave.addEventListener("click", () => {
      geoSelectedCodes = Array.from(geoModalDraft);
      renderGeoTags();
      closeGeoCountryModal();
    });
  }
  const geoModalSearch = $("geo-modal-search");
  if (geoModalSearch) {
    geoModalSearch.addEventListener("input", () => renderGeoModalList(geoModalSearch.value));
  }
  const inboundModal = $("inbound-modal");
  const inboundBackdrop = inboundModal && inboundModal.querySelector(".modal-backdrop");
  if (inboundBackdrop) inboundBackdrop.addEventListener("click", closeInboundEditor);
  const routeModal = $("route-modal");
  const routeBackdrop = routeModal && routeModal.querySelector(".modal-backdrop");
  if (routeBackdrop) routeBackdrop.addEventListener("click", closeRouteEditor);
  const peerModal = $("peer-modal");
  const peerBackdrop = peerModal && peerModal.querySelector(".modal-backdrop");
  if (peerBackdrop) peerBackdrop.addEventListener("click", closePeerEditor);
  const confirmModal = $("confirm-modal");
  const confirmBackdrop = confirmModal && confirmModal.querySelector(".modal-backdrop");
  if (confirmBackdrop) confirmBackdrop.addEventListener("click", closeConfirmModal);
  $("confirm-modal-cancel").addEventListener("click", closeConfirmModal);
  $("confirm-modal-ok").addEventListener("click", async () => {
    const fn = confirmModalCallback;
    closeConfirmModal();
    if (fn) await fn();
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const gm = $("geo-country-modal");
    if (gm && !gm.classList.contains("is-hidden")) {
      closeGeoCountryModal();
      ev.preventDefault();
      return;
    }
    const cm = $("confirm-modal");
    if (cm && !cm.classList.contains("is-hidden")) {
      closeConfirmModal();
      ev.preventDefault();
      return;
    }
    const rm = $("route-modal");
    if (rm && !rm.classList.contains("is-hidden")) {
      closeRouteEditor();
      ev.preventDefault();
      return;
    }
    const im = $("inbound-modal");
    if (im && !im.classList.contains("is-hidden")) {
      closeInboundEditor();
      ev.preventDefault();
      return;
    }
    const pm = $("peer-modal");
    if (pm && !pm.classList.contains("is-hidden")) {
      closePeerEditor();
      ev.preventDefault();
    }
  });

  $("stats-refresh").addEventListener("click", refreshStatsPage);
  $("logs-refresh").addEventListener("click", refreshLogsPage);

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
      refreshOnboardInstallCmd();
      return;
    }
    setOnboardMsg("…");
    try {
      const kp = await generatePeerKeypairBrowser();
      $("peer-f-pub").value = kp.publicKey;
      $("onboard-client-priv").value = kp.privateKey;
      setOnboardMsg("New keypair generated.");
      refreshOnboardInstallCmd();
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

  $("onboard-install-copy").addEventListener("click", () => {
    void copyOnboardInstallCmd();
  });

  function onPeerModalFieldActivity() {
    const pm = $("peer-modal");
    if (!pm || pm.classList.contains("is-hidden")) return;
    refreshOnboardInstallCmd();
    schedulePeerOverviewFromModal();
  }

  ["peer-f-name", "peer-f-tunnel", "peer-f-pub", "onboard-endpoint", "onboard-client-priv"].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener("input", onPeerModalFieldActivity);
  });
  const peerDisabled = $("peer-f-disabled");
  if (peerDisabled) peerDisabled.addEventListener("change", onPeerModalFieldActivity);

  $("pending-refresh").addEventListener("click", refreshPendingPage);
  const pendingModeUnified = $("pending-mode-unified");
  const pendingModeSplit = $("pending-mode-split");
  if (pendingModeUnified) {
    pendingModeUnified.addEventListener("click", () => {
      setPendingDiffMode("unified");
      renderPendingDiffPanel();
    });
  }
  if (pendingModeSplit) {
    pendingModeSplit.addEventListener("click", () => {
      setPendingDiffMode("split");
      renderPendingDiffPanel();
    });
  }
  $("pending-apply").addEventListener("click", async () => {
    setPendingMsg("…");
    try {
      await api("/v1/reload", { method: "POST" });
      setPendingMsg("Applied to host.");
      await refreshPendingPage();
      await refreshPendingBadge();
      setApiStatus(true);
    } catch (e) {
      setPendingMsg(String(e.message || e), true);
    }
  });

  const pendingDiscard = $("pending-discard");
  if (pendingDiscard) {
    pendingDiscard.addEventListener("click", () => {
      openConfirmModal({
        title: "Discard pending?",
        message:
          "Replace the saved config.yaml with config.yaml.bak (the last applied snapshot). Unsaved edits that differ from that snapshot are lost. The host is not updated until you apply or reload.",
        confirmLabel: "Discard pending",
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/discard", { method: "POST" });
            setPendingMsg("Pending changes discarded. Apply or reload when ready.");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }

  const pendingRestore = $("pending-restore-previous");
  if (pendingRestore) {
    pendingRestore.addEventListener("click", () => {
      openConfirmModal({
        title: "Restore previous applied?",
        message:
          "Replace config.yaml with the first older snapshot in config.yaml.bak.1 … .bak.5 that differs from config.yaml.bak. Any current config.yaml content is overwritten (including edits not yet applied to the host). The host is not updated until you apply or reload.",
        confirmLabel: "Restore",
        onConfirm: async () => {
          setPendingMsg("…");
          try {
            await api("/v1/config/restore-previous-applied", { method: "POST" });
            setPendingMsg("Restored previous applied config. Apply or reload when ready.");
            await refreshPendingPage();
            await refreshPendingBadge();
            setApiStatus(true);
          } catch (e) {
            setPendingMsg(String(e.message || e), true);
          }
        },
      });
    });
  }

  void onHash();
})();
