(function () {
  const apiBase = window.EVUPROXY_API || "/api";
  const peerInstallScriptUrl =
    window.EVUPROXY_PEER_INSTALL_SCRIPT_URL ||
    "https://raw.githubusercontent.com/imevul/evuproxy/main/scripts/peer-install.sh";
  const tokenKey = "evuproxy_api_token";
  const endpointKey = "evuproxy_onboard_endpoint";
  const peerSubnetKey = "evuproxy_peer_subnet_cidr";
  const defaultPeerSubnetCidr = "10.100.0.0/24";

  const $ = (id) => document.getElementById(id);

  let lastOverview = null;
  let lastConfig = null;
  let peerOverviewFetchSeq = 0;
  let peerOverviewDebounceTimer = null;

  const pages = ["overview", "settings", "token", "peers", "routes", "inbound", "pending", "stats"];

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

  async function api(path, opts = {}) {
    const r = await fetch(apiBase + path, {
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
    if (name === "overview") refreshOverviewPage();
    if (name === "settings") await refreshSettingsPage();
    if (name === "token") refreshTokenPage();
    if (name === "peers") refreshPeersPage();
    if (name === "routes") refreshRoutesPage();
    if (name === "inbound") refreshInboundPage();
    if (name === "pending") refreshPendingPage();
    if (name === "stats") refreshStatsPage();
    refreshPendingBadge();
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

  async function refreshOverviewPage() {
    const grid = $("overview-cards");
    const msg = $("overview-action-msg");
    if (!grid) return;
    grid.innerHTML = "";
    msg.textContent = "";
    try {
      const o = await api("/v1/overview");
      lastOverview = o;
      setApiStatus(true);
      grid.appendChild(elStat("WireGuard", o.wireguard_interface + " · UDP " + o.wireguard_listen_port));
      grid.appendChild(elStat("Public NIC", o.public_interface));
      const n = (o.forwarding_routes && o.forwarding_routes.length) || 0;
      const fwd = n + " route(s)";
      grid.appendChild(elStat("Forwarding", fwd));
      grid.appendChild(elStat("Geo", o.geo_enabled ? (o.geo_countries || []).join(", ") : "off"));
      grid.appendChild(elStat("Peers", String((o.peer_names || []).length)));
    } catch (e) {
      setApiStatus(false, String(e.message || e));
      grid.appendChild(elStat("Error", String(e.message || e)));
    }
  }

  function setOverviewMsg(text, isErr) {
    const el = $("overview-action-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  /* ——— Settings ——— */
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
  }

  function refreshTokenPage() {
    const el = $("token");
    if (!el) return;
    el.value = sessionStorage.getItem(tokenKey) || localStorage.getItem(tokenKey) || "";
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

  function renderPeersTable(cfg) {
    const wrap = $("peers-table-wrap");
    if (!cfg || !cfg.peers) {
      wrap.innerHTML = "<p class=\"hint\">No peers.</p>";
      return;
    }
    const rows = cfg.peers
      .map(
        (p, i) =>
          `<tr><td>${escapeHtml(p.name)}</td><td class="mono">${escapeHtml(p.tunnel_ip)}</td><td class="mono">${escapeHtml(trunc(p.public_key, 20))}</td><td>${p.disabled ? "yes" : ""}</td><td class="row-actions"><button type="button" data-peer-edit="${i}">Edit</button> <button type="button" data-peer-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      )
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Name</th><th>Tunnel IP</th><th>Public key</th><th>Disabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll("[data-peer-edit]").forEach((b) => {
      b.addEventListener("click", () => openPeerEditor(+b.getAttribute("data-peer-edit")));
    });
    wrap.querySelectorAll("[data-peer-del]").forEach((b) => {
      b.addEventListener("click", () => removePeer(+b.getAttribute("data-peer-del")));
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

  async function refreshPeersPage() {
    setPeersMsg("");
    try {
      lastConfig = await api("/v1/config");
      setApiStatus(true);
      renderPeersTable(lastConfig);
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
    $("peer-f-disabled").checked = !!p.disabled;
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
      disabled: $("peer-f-disabled").checked,
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
          `<tr><td>${formatRouteProtoCell(r.proto)}</td><td class="mono">${escapeHtml((r.ports || []).join(", "))}</td><td class="mono">${escapeHtml(r.target_ip)}</td><td class="row-actions"><button type="button" data-route-edit="${i}">Edit</button> <button type="button" data-route-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      )
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Ports</th><th>Target</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll("[data-route-edit]").forEach((b) => {
      b.addEventListener("click", () => openRouteEditor(+b.getAttribute("data-route-edit")));
    });
    wrap.querySelectorAll("[data-route-del]").forEach((b) => {
      b.addEventListener("click", () => removeRoute(+b.getAttribute("data-route-del")));
    });
  }

  function openRouteEditor(index) {
    const cfg = lastConfig;
    if (!cfg) return;
    if (!cfg.forwarding.routes) cfg.forwarding.routes = [];
    peerTunnelIPv4Options(cfg);
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
    const entry = { proto, ports, target_ip: target };
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
      .map(
        (r, i) =>
          `<tr><td class="mono">${escapeHtml(String(r.proto || "").toLowerCase())}</td><td class="mono">${escapeHtml(r.dport || "")}</td><td>${escapeHtml(r.note || "—")}</td><td class="row-actions"><button type="button" data-inbound-edit="${i}">Edit</button> <button type="button" data-inbound-del="${i}" class="btn-quiet">Remove</button></td></tr>`
      )
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Port(s)</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll("[data-inbound-edit]").forEach((b) => {
      b.addEventListener("click", () => openInboundEditor(+b.getAttribute("data-inbound-edit")));
    });
    wrap.querySelectorAll("[data-inbound-del]").forEach((b) => {
      b.addEventListener("click", () => removeInboundRule(+b.getAttribute("data-inbound-del")));
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

    if (index === -1) {
      $("inbound-edit-index").value = "";
      $("inbound-editor-title").textContent = "Add rule";
      protoSel.value = "tcp";
      dport.value = "";
      note.value = "";
    } else {
      const r = cfg.input_allows[index];
      if (!r) return;
      $("inbound-edit-index").value = String(index);
      $("inbound-editor-title").textContent = "Edit rule";
      const p = String(r.proto || "tcp").toLowerCase();
      protoSel.value = p === "udp" ? "udp" : "tcp";
      dport.value = r.dport || "";
      note.value = r.note || "";
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
    if (!dport) {
      setInboundMsg("Destination port is required.", true);
      return;
    }
    const entry = { proto, dport };
    if (note) entry.note = note;
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

  function setPendingMsg(text, isErr) {
    const el = $("pending-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
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
    const pre = $("pending-nft");
    if (!status || !pre) return;
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
      pre.textContent = p.nftables || "";
    } catch (e) {
      status.textContent = "";
      status.classList.remove("pending-yes", "pending-no");
      pre.textContent = "";
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
      if (st.wireguard_peers && st.wireguard_peers.length) {
        const rows = st.wireguard_peers
          .map(
            (p) =>
              `<tr><td class="mono">${escapeHtml(trunc(p.public_key, 24))}</td><td>${escapeHtml(p.endpoint || "—")}</td><td class="mono">${escapeHtml(fmtHandshake(p.latest_handshake_unix))}</td><td>${p.transfer_rx} / ${p.transfer_tx}</td></tr>`
          )
          .join("");
        wgW.innerHTML = `<table class="data"><thead><tr><th>Public key</th><th>Endpoint</th><th>Handshake</th><th>RX / TX</th></tr></thead><tbody>${rows}</tbody></table>`;
      } else {
        wgW.innerHTML = "<p class=\"hint\">No peer stats (interface down or mock).</p>";
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
    return (
      "export EVUPROXY_WG_PRIVATE_KEY=" +
      q(p.priv) +
      " EVUPROXY_WG_ADDRESS=" +
      q(p.tip) +
      " EVUPROXY_WG_SERVER_PUBLIC_KEY=" +
      q(p.serverPublicKey) +
      " EVUPROXY_WG_ENDPOINT=" +
      q(p.ep) +
      " EVUPROXY_WG_ALLOWED_IPS=" +
      q(p.subnet) +
      " && curl -fsSL " +
      q(peerInstallScriptUrl) +
      " | sudo -E bash"
    );
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
      ev.preventDefault();
      void navigate(a.getAttribute("data-route"));
    });
  });
  window.addEventListener("hashchange", () => void onHash());

  const savedTok = localStorage.getItem(tokenKey);
  if (savedTok && $("token")) $("token").value = savedTok;

  $("save-token").addEventListener("click", () => {
    const t = $("token").value.trim();
    if (!t) return;
    localStorage.setItem(tokenKey, t);
    invalidateUIPrefsCache();
    setAuthMsg("Token saved in browser storage.");
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
    $("peer-f-disabled").checked = false;
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

  void onHash();
})();
