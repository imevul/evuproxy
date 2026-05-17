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

  const tokenKey = "evuproxy_api_token";
  const endpointKey = "evuproxy_onboard_endpoint";
  const peerSubnetKey = "evuproxy_peer_subnet_cidr";
  const defaultPeerSubnetCidr = "10.100.0.0/24";
  const advancedSettingsKey = "evuproxy_advanced_settings";
  const contentWidthKey = "evuproxy_content_width";
  const contentWidthCssValues = {
    small: "900px",
    medium: "1200px",
    large: "1400px",
    full: "100%",
  };

  const $ = (id) => document.getElementById(id);

  let lastOverview = null;
  let lastConfig = null;
  /** True only after a successful GET /v1/overview with the current token (or unset token → false). */
  let apiConnectionOk = false;
  /** Last /v1/stats response for peer online/offline column (null if unavailable). */
  let lastPeerWgStats = null;
  /** Map tunnel IPv4 host -> last /v1/metrics/peers row; null if not fetched. */
  let lastPeerPingByTunnel = null;
  let peerOverviewFetchSeq = 0;
  let peerOverviewDebounceTimer = null;
  /** Ignores stale results when multiple refreshOverviewPage runs overlap (navigate + save-token, etc.). */
  let overviewRefreshSeq = 0;

  /** Parsed firewall log lines from last successful GET /v1/logs (client-side filter/table). */
  let lastFirewallLogEntries = [];
  let logsViewMode = "table";
  let logsSearchDebounceTimer = null;
  /** Ignores stale responses when multiple refreshLogsPage calls overlap. */
  let logsRefreshSeq = 0;

  let overviewEventsTimer = null;
  let topologyPollTimer = null;
  /** Last events list from GET /v1/events (for CSV export). */
  let lastEventsForExport = [];
  /** Query string from hash for ?peer= / ?route= highlighting */
  let hashNavParams = new URLSearchParams();
  const GEO_STALE_MS = 30 * 24 * 60 * 60 * 1000;
  /** WireGuard transfer_rx+transfer_tx totals per public_key for topology edge animation */
  let topologyPrevPeerBytes = new Map();
  let topologyRefreshInFlight = false;
  /** Pan/zoom for topology SVG (user space / viewBox coordinates). */
  let topologyPanX = 0;
  let topologyPanY = 0;
  let topologyZoomK = 1;
  let topologyPanDrag = null;

  const pages = [
    "overview",
    "settings",
    "token",
    "peers",
    "routes",
    "topology",
    "inbound",
    "geoblocking",
    "pending",
    "stats",
    "logs",
  ];

  let lastUIPrefs = {
    peer_tunnel_subnet_cidr: "",
    wireguard_server_endpoint: "",
    metrics_collection_enabled: false,
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
      metrics_collection_enabled: !!p.metrics_collection_enabled,
    };
    migrateFromLocalStorageIfEmpty();
  }

  async function ensureUIPrefs() {
    if (uiPrefsFetched) return;
    try {
      await fetchUIPrefsFromServer();
    } catch {
      lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "", metrics_collection_enabled: false };
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

  function headersDownload() {
    const t = token();
    const h = { Accept: "*/*" };
    if (t) h["X-API-Token"] = t;
    return h;
  }

  function downloadTextFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function stopOverviewEventsPolling() {
    if (overviewEventsTimer) {
      clearInterval(overviewEventsTimer);
      overviewEventsTimer = null;
    }
  }

  function restartOverviewEventsPolling() {
    stopOverviewEventsPolling();
    void refreshOverviewEventsList();
    overviewEventsTimer = setInterval(refreshOverviewEventsList, 30000);
  }

  async function refreshOverviewEventsList() {
    const ul = $("overview-events-list");
    const empty = $("overview-events-empty");
    const card = $("overview-events-card");
    if (!ul || !empty) return;
    if (!token().trim()) {
      ul.innerHTML = "";
      empty.classList.remove("is-hidden");
      if (card) card.hidden = true;
      return;
    }
    if (card) card.hidden = false;
    try {
      const data = await api("/v1/events?limit=25");
      const evs = data.events || [];
      if (!evs.length) {
        ul.innerHTML = "";
        empty.classList.remove("is-hidden");
        lastEventsForExport = [];
        return;
      }
      empty.classList.add("is-hidden");
      lastEventsForExport = evs;
      ul.innerHTML = evs
        .map(
          (e) =>
            "<li><span class=\"overview-ev-ts\">" +
            escapeHtml(e.ts || "") +
            "</span> <strong>" +
            escapeHtml(e.event || "") +
            "</strong>" +
            (e.detail ? " — " + escapeHtml(e.detail) : "") +
            (e.error_code ? " <code class=\"inline\">" + escapeHtml(e.error_code) + "</code>" : "") +
            "</li>"
        )
        .join("");
    } catch {
      /* non-fatal */
    }
  }

  function stopTopologyPolling() {
    if (topologyPollTimer) {
      clearInterval(topologyPollTimer);
      topologyPollTimer = null;
    }
  }

  function applyPeersRoutesTableFilter() {
    const q = ($("global-table-search") && $("global-table-search").value.trim().toLowerCase()) || "";
    document.querySelectorAll("#peers-table-wrap tbody tr[data-filter]").forEach((tr) => {
      const h = tr.getAttribute("data-filter") || "";
      tr.classList.toggle("is-filter-hidden", !!q && !h.includes(q));
    });
    document.querySelectorAll("#routes-table-wrap tbody tr[data-filter]").forEach((tr) => {
      const h = tr.getAttribute("data-filter") || "";
      tr.classList.toggle("is-filter-hidden", !!q && !h.includes(q));
    });
  }

  async function refreshGeoZonesTable() {
    const wrap = $("geo-zones-table-wrap");
    const msg = $("geo-zones-msg");
    if (!wrap || !msg) return;
    msg.textContent = "";
    msg.classList.remove("err");
    try {
      const s = await api("/v1/geo/summary");
      if (!s.enabled) {
        wrap.innerHTML = "<p class=\"hint meta\">Geoblocking is off in config.</p>";
        return;
      }
      const rows = (s.countries || [])
        .map((c) => {
          const miss = c.zone_missing ? " <span class=\"meta\">(zone file missing)</span>" : "";
          const codeRaw = String(c.code || "").trim();
          const fl = countryFlagEmoji(codeRaw);
          const flagHtml = fl
            ? '<span class="logs-ip-flag" title="' + escapeHtml(codeRaw.toUpperCase()) + '">' + fl + "</span> "
            : "";
          return (
            "<tr><td class=\"mono geo-zones-col-country\">" +
            flagHtml +
            escapeHtml(codeRaw) +
            "</td><td>" +
            escapeHtml(String(c.cidr_lines)) +
            "</td><td>" +
            escapeHtml(String(c.approx_ipv4_addresses)) +
            "</td><td>" +
            (c.zone_read_error ? escapeHtml(c.zone_read_error) : "—") +
            miss +
            "</td></tr>"
          );
        })
        .join("");
      let foot = "";
      if (s.nft_set_elem_count != null) {
        foot =
          "<p class=\"hint meta\">Merged <code class=\"inline\">inet</code> set element count: " +
          escapeHtml(String(s.nft_set_elem_count)) +
          (s.nft_set_count_source ? " (" + escapeHtml(s.nft_set_count_source) + ")" : "") +
          "</p>";
      }
      wrap.innerHTML =
        "<table class=\"data\"><thead><tr><th>Country</th><th>CIDR lines</th><th>Approx. IPv4</th><th>Note</th></tr></thead><tbody>" +
        rows +
        "</tbody></table>" +
        foot;
    } catch (e) {
      msg.textContent = String(e.message || e);
      msg.classList.add("err");
      wrap.innerHTML = "";
    }
  }

  function expandRoutePortTokens(portsArr) {
    /** Keep in sync with internal/config/ports_expand.go ExpandRoutePortNumbers. */
    const MAX_DISTINCT = 65535;
    let over = false;
    const seen = new Set();
    const addPort = (p) => {
      const n = p | 0;
      if (n >= 1 && n <= 65535) {
        seen.add(n);
        if (seen.size > MAX_DISTINCT) {
          over = true;
        }
      }
    };
    const expandTok = (tok) => {
      tok = String(tok || "").trim();
      if (!tok) return;
      const i = tok.indexOf("-");
      if (i >= 0) {
        const a = +tok.slice(0, i).trim();
        const b = +tok.slice(i + 1).trim();
        if (!(a >= 1 && b <= 65535 && a <= b && a === (a | 0) && b === (b | 0))) return;
        for (let p = a; p <= b; p++) addPort(p);
      } else {
        const p = +tok;
        if (p >= 1 && p <= 65535 && p === (p | 0)) addPort(p);
      }
    };
    for (const raw of portsArr || []) {
      let s = String(raw || "").trim();
      if (!s) continue;
      if (s.startsWith("{") && s.endsWith("}")) {
        s = s.slice(1, -1);
        for (const part of s.split(",")) expandTok(part.trim());
      } else {
        expandTok(s);
      }
    }
    return over ? null : Array.from(seen).sort((a, b) => a - b);
  }

  let routeProbePending = null;
  /** Pending parsed config from file upload (replace flow). */
  let configUploadDraft = null;
  /** Last /v1/metrics/peers response for CSV export on Stats page. */
  let lastMetricsPeersExport = null;

  function closeRouteProbeModal() {
    routeProbePending = null;
    const m = $("route-probe-modal");
    if (m) m.classList.add("is-hidden");
  }

  function openRouteProbeModal(index) {
    const routes = lastConfig && lastConfig.forwarding && lastConfig.forwarding.routes;
    if (!routes || routes[index] === undefined) return;
    const r = routes[index];
    if (r.disabled) {
      setRoutesMsg("Route is disabled.", true);
      return;
    }
    const expanded = expandRoutePortTokens(r.ports);
    if (expanded === null) {
      setRoutesMsg("This route expands to too many distinct ports to pick one here.", true);
      return;
    }
    if (!expanded.length) {
      setRoutesMsg("Route has no ports.", true);
      return;
    }
    if (expanded.length === 1) {
      void runRouteProbeWithPort(index, expanded[0]);
      return;
    }
    routeProbePending = { index, portsSet: new Set(expanded) };
    const hint = $("route-probe-modal-hint");
    if (hint) {
      hint.innerHTML =
        "Target <span class=\"mono\">" +
        escapeHtml(String(r.target_ip || "")) +
        "</span> — " +
        escapeHtml(formatRouteProtoCell(r.proto)) +
        " — <strong>" +
        expanded.length +
        "</strong> ports.";
    }
    const num = $("route-probe-port-input");
    if (num) {
      num.value = String(expanded[0]);
      num.min = "1";
      num.max = "65535";
    }
    const modal = $("route-probe-modal");
    if (modal) {
      modal.classList.remove("is-hidden");
      if (num) requestAnimationFrame(() => num.focus());
    }
  }

  async function runRouteProbeWithPort(index, port) {
    setRoutesMsg("…");
    try {
      const body = { route_index: index, port: port | 0 };
      const res = await api("/v1/routes/test", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const parts = (res.results || []).map(
        (r) => r.proto + " port " + r.port + ": " + r.status + (r.error_detail ? " — " + r.error_detail : "")
      );
      setRoutesMsg(parts.join("; ") || "No results.");
    } catch (e) {
      setRoutesMsg(String(e.message || e), true);
    }
  }

  function runRouteProbe(index) {
    openRouteProbeModal(index);
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
      const ex = new Error(err);
      if (body.error_code) ex.errorCode = body.error_code;
      throw ex;
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
    hashNavParams = parseHashNavParams();
    closeConfirmModal();
    if (name !== "routes") {
      closeRouteProbeModal();
      closeRouteEditor();
    }
    if (name !== "inbound") closeInboundEditor();
    if (name !== "peers") {
      stopPeersPingPolling();
      closePeerEditor();
    }
    if (name !== "topology") {
      stopTopologyPolling();
    }
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
    const hraw = (location.hash || "").replace(/^#/, "");
    const hqi = hraw.indexOf("?");
    const curPath = (hqi >= 0 ? hraw.slice(0, hqi) : hraw).replace(/^\//, "").split("/")[0] || "overview";
    if (curPath !== name) {
      location.hash = "#/" + name;
    }
    if (name === "overview") {
      await refreshOverviewPage();
      restartOverviewEventsPolling();
    } else {
      stopOverviewEventsPolling();
    }
    if (name === "settings") {
      await refreshSettingsPage();
      setSettingsEditorTab("prefs");
    }
    if (name === "token") {
      refreshTokenPage();
      await ensureApiGate();
    }
    if (name === "peers") {
      await refreshPeersPage();
      applyHashPeerRouteHighlight();
    }
    if (name === "routes") {
      await refreshRoutesPage();
      applyHashPeerRouteHighlight();
    }
    if (name === "topology") {
      topologyPrevPeerBytes = new Map();
      void refreshTopologyPage();
      topologyPollTimer = setInterval(() => {
        void refreshTopologyPage();
      }, 4000);
    }
    if (name === "inbound") refreshInboundPage();
    if (name === "geoblocking") await refreshGeoblockingPage();
    if (name === "pending") refreshPendingPage();
    if (name === "stats") refreshStatsPage();
    if (name === "logs") refreshLogsPage();
    refreshPendingBadge();
    void refreshSidebarAbout();
  }

  function applyHashPeerRouteHighlight() {
    document.querySelectorAll("#peers-table-wrap tr.row-highlight, #routes-table-wrap tr.row-highlight").forEach((tr) => {
      tr.classList.remove("row-highlight");
    });
    const pi = hashNavParams.get("peer");
    if (pi !== null && $("page-peers") && !$("page-peers").hidden) {
      const idx = parseInt(pi, 10);
      if (!isNaN(idx)) {
        const btn = document.querySelector("#peers-table-wrap [data-peer-edit=\"" + idx + "\"]");
        const tr = btn && btn.closest("tr");
        if (tr) {
          tr.classList.add("row-highlight");
          tr.scrollIntoView({ block: "nearest" });
        }
      }
    }
    const ri = hashNavParams.get("route");
    if (ri !== null && $("page-routes") && !$("page-routes").hidden) {
      const idx = parseInt(ri, 10);
      if (!isNaN(idx)) {
        const btn = document.querySelector("#routes-table-wrap [data-route-edit=\"" + idx + "\"]");
        const tr = btn && btn.closest("tr");
        if (tr) {
          tr.classList.add("row-highlight");
          tr.scrollIntoView({ block: "nearest" });
        }
      }
    }
  }

  async function onHash() {
    const raw = (location.hash || "#/overview").replace(/^#/, "");
    const qi = raw.indexOf("?");
    const pathPart = qi >= 0 ? raw.slice(0, qi) : raw;
    hashNavParams = qi >= 0 ? new URLSearchParams(raw.slice(qi + 1)) : new URLSearchParams();
    const name = pathPart.replace(/^\//, "").split("/")[0] || "overview";
    await navigate(name || "overview");
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

  function parseHashNavParams() {
    const raw = (location.hash || "").replace(/^#/, "");
    const qi = raw.indexOf("?");
    if (qi < 0) return new URLSearchParams();
    return new URLSearchParams(raw.slice(qi + 1));
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

  function csvEscapeCell(s) {
    const t = String(s ?? "");
    if (/[",\n\r]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
    return t;
  }

  function eventsToCsv(events) {
    const rows = [["ts", "event", "detail", "error_code"]];
    for (const e of events || []) {
      rows.push([e.ts || "", e.event || "", e.detail || "", e.error_code || ""]);
    }
    return rows.map((r) => r.map(csvEscapeCell).join(",")).join("\n") + "\n";
  }

  function metricsPeersToCsv(data) {
    const peers = (data && data.peers) || [];
    const rows = [["name", "tunnel_ip", "ok", "latency_ms", "ts_utc"]];
    for (const p of peers) {
      rows.push([
        p.name || "",
        p.tunnel_ip || "",
        p.ok === true ? "true" : p.ok === false ? "false" : "",
        p.latency_ms ?? "",
        p.ts_utc || "",
      ]);
    }
    return rows.map((r) => r.map(csvEscapeCell).join(",")).join("\n") + "\n";
  }

  function formatGeoAge(isoUtc) {
    const d = Date.parse(isoUtc);
    if (isNaN(d)) return "";
    const days = Math.floor((Date.now() - d) / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "1 day ago";
    return days + " days ago";
  }

  function buildOverviewAttentionItems(cfg, o, st, met) {
    const items = [];
    const peers = (cfg && cfg.peers) || [];
    const pubMap = wgPeerPubKeyMap(st);
    for (const p of peers) {
      if (p.disabled) continue;
      const row = pubMap.get((p.public_key || "").trim());
      const h = row && row.latest_handshake_unix;
      if (!h || h <= 0) {
        items.push('Peer "' + (p.name || "unnamed") + '" has no WireGuard handshake yet.');
      } else if (Math.floor(Date.now() / 1000) - h > PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC) {
        items.push('Peer "' + (p.name || "unnamed") + '" looks offline (stale handshake).');
      }
    }
    const disabledByTunnel = new Set();
    for (const p of peers) {
      if (p.disabled) {
        const th = tunnelToHost(p.tunnel_ip);
        if (th) disabledByTunnel.add(th);
      }
    }
    const routes = (cfg && cfg.forwarding && cfg.forwarding.routes) || [];
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (r.disabled) continue;
      const tip = String(r.target_ip || "").trim();
      if (tip && disabledByTunnel.has(tip)) {
        items.push("Route #" + (i + 1) + " targets a disabled peer tunnel (" + tip + ").");
      }
    }
    if (met && !met.collection_disabled && (!met.peers || !met.peers.length)) {
      items.push("Peer metrics collection is enabled but no samples are stored yet.");
    }
    if (o && o.geo_enabled && !o.geo_last_success_utc) {
      items.push("Geoblocking is on but geo zone files have never loaded successfully on this host.");
    }
    return items;
  }

  function overviewAttentionCard(items) {
    const wrap = document.createElement("div");
    wrap.className = "card overview-attention-card";
    if (!items.length) {
      wrap.innerHTML = "<h3>Status</h3><p class=\"meta\">No warnings from this pass.</p>";
      return wrap;
    }
    wrap.innerHTML =
      "<h3>Needs attention</h3><ul class=\"attention-list\">" +
      items.map((t) => "<li>" + escapeHtml(t) + "</li>").join("") +
      "</ul>";
    return wrap;
  }

  function overviewApplyStatusCard(evs) {
    const wrap = document.createElement("div");
    wrap.className = "card";
    let line = "No recent reload or geo events in the last fetch.";
    const list = evs || [];
    for (const e of list) {
      const ev = (e && e.event) || "";
      if (
        ev === "reload_ok" ||
        ev === "reload_failed" ||
        ev === "update_geo_ok" ||
        ev === "update_geo_failed" ||
        ev === "backup_ok" ||
        ev === "restore_ok"
      ) {
        line = (e.ts || "") + " — " + ev + (e.detail ? " — " + e.detail : "");
        break;
      }
    }
    wrap.innerHTML = "<h3>Last apply activity</h3><p class=\"meta\">" + escapeHtml(line) + "</p>";
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
      const evCard0 = $("overview-events-card");
      if (evCard0) evCard0.hidden = true;
      return;
    }
    try {
      try {
        await fetchUIPrefsFromServer();
      } catch (e) {
        /* keep lastUIPrefs; overview still useful */
      }
      const [o, met, cfg, st, evPack] = await Promise.all([
        api("/v1/overview"),
        api("/v1/metrics/peers").catch(() => null),
        api("/v1/config").catch(() => null),
        api("/v1/stats").catch(() => null),
        api("/v1/events?limit=40").catch(() => ({ events: [] })),
      ]);
      const evs = (evPack && evPack.events) || [];
      if (seq !== overviewRefreshSeq) return;
      lastOverview = o;
      lastConfig = cfg || lastConfig;
      apiConnectionOk = true;
      applyNavRestriction();
      setApiStatus(true);
      if (actionsCard) actionsCard.hidden = false;
      grid.appendChild(overviewApplyStatusCard(evs));
      grid.appendChild(overviewAttentionCard(buildOverviewAttentionItems(cfg, o, st, met)));
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
      if (o.geo_enabled) {
        if (o.geo_last_success_utc) {
          const d = Date.parse(o.geo_last_success_utc);
          const stale = !isNaN(d) && Date.now() - d > GEO_STALE_MS;
          const age = formatGeoAge(o.geo_last_success_utc);
          grid.appendChild(
            elStat(
              "Geo zones freshness",
              (stale ? "Stale — " : "OK — ") +
                age +
                (o.geo_last_success_source ? " · " + o.geo_last_success_source : "") +
                " · " +
                o.geo_last_success_utc
            )
          );
        } else {
          grid.appendChild(elStat("Geo zones freshness", "Never loaded — use Update geo lists"));
        }
      }
      const cardLp = elStat("Peer latency (last ping)", "…");
      const card10 = elStat("Peer latency (last 10 min)", "…");
      grid.appendChild(cardLp);
      grid.appendChild(card10);
      const vLp = cardLp.querySelector(".value");
      const v10 = card10.querySelector(".value");
      if (met) {
        vLp.textContent = formatDashboardMinAvgMax(met.dashboard && met.dashboard.last_ping, met.collection_disabled);
        v10.textContent = formatDashboardMinAvgMax(met.dashboard && met.dashboard.last_10m, met.collection_disabled);
      } else {
        vLp.textContent = "—";
        v10.textContent = "—";
      }
      void refreshOverviewEventsList();
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
      const evUl = $("overview-events-list");
      const evEmpty = $("overview-events-empty");
      const evCard = $("overview-events-card");
      if (evUl) evUl.innerHTML = "";
      if (evEmpty) evEmpty.classList.remove("is-hidden");
      if (evCard) evCard.hidden = true;
    }
  }

  function setOverviewMsg(text, isErr) {
    const el = $("overview-action-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

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

  function syncContentWidthSelect() {
    const sel = $("settings-content-width");
    if (!sel) return;
    const p = getContentWidthPreset();
    sel.value = Object.prototype.hasOwnProperty.call(contentWidthCssValues, p) ? p : "medium";
  }

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
    syncGeoAdvancedFieldsVisibility();
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

  function geoblockingFormSnapshotForCompare() {
    return {
      enabled: !!($("geo-f-enabled") && $("geo-f-enabled").checked),
      mode: getGeoListMode(),
      countries: geoSelectedCodes
        .slice()
        .map((c) => String(c).trim().toLowerCase())
        .filter(Boolean)
        .sort(),
      set_name: (($("geo-f-set-name") && $("geo-f-set-name").value) || "").trim(),
      zone_dir: (($("geo-f-zone-dir") && $("geo-f-zone-dir").value) || "").trim(),
      apply_to_input_allows: !!($("geo-f-apply-input-allows") && $("geo-f-apply-input-allows").checked),
    };
  }

  function geoblockingServerSnapshotForCompare() {
    if (!lastConfig) return null;
    const g = lastConfig.geo || {};
    return {
      enabled: !!g.enabled,
      mode: String(g.mode || "allow").toLowerCase() === "block" ? "block" : "allow",
      countries: (Array.isArray(g.countries) ? g.countries : [])
        .map((c) => String(c).trim().toLowerCase())
        .filter(Boolean)
        .sort(),
      set_name: String(g.set_name || "").trim(),
      zone_dir: String(g.zone_dir || "").trim(),
      apply_to_input_allows: !!g.apply_to_input_allows,
    };
  }

  function syncGeoUnsavedIndicator() {
    const el = $("geo-unsaved-msg");
    if (!el) return;
    const srv = geoblockingServerSnapshotForCompare();
    if (!srv) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const cur = geoblockingFormSnapshotForCompare();
    const dirty = JSON.stringify(cur) !== JSON.stringify(srv);
    if (dirty) {
      el.hidden = false;
      el.textContent = "You have unsaved changes — click Save to write them to the server config.";
    } else {
      el.hidden = true;
      el.textContent = "";
    }
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
      lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "", metrics_collection_enabled: false };
      migrateFromLocalStorageIfEmpty();
    }
    const cidr = $("peer-subnet-cidr");
    if (cidr) cidr.value = (lastUIPrefs.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr;
    const sep = $("settings-wg-endpoint");
    if (sep) sep.value = (lastUIPrefs.wireguard_server_endpoint || "").trim();
    const spl = $("settings-metrics-collection");
    if (spl) spl.checked = !!lastUIPrefs.metrics_collection_enabled;
    syncAdvancedSettingsToggle();
    syncGeoAdvancedFieldsVisibility();
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

  function setSettingsEditorTab(which) {
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

  let peersPingTimer = null;

  function stopPeersPingPolling() {
    if (peersPingTimer) {
      clearInterval(peersPingTimer);
      peersPingTimer = null;
    }
  }

  function showPeersMetricsColumn() {
    return !!lastUIPrefs.metrics_collection_enabled;
  }

  async function fetchPeerMetricsMap() {
    const body = await api("/v1/metrics/peers");
    const m = new Map();
    for (const row of body.peers || []) {
      const tip = String(row.tunnel_ip || "").trim();
      if (tip) m.set(tip, row);
    }
    return m;
  }

  function formatDashboardMinAvgMax(block, collectionDisabled) {
    if (block && typeof block.min_ms === "number" && typeof block.avg_ms === "number" && typeof block.max_ms === "number") {
      return block.min_ms + " / " + block.avg_ms + " / " + block.max_ms + " ms";
    }
    if (collectionDisabled) return "Collection off";
    return "—";
  }

  function tunnelHostOnly(tunnelIp) {
    const s = String(tunnelIp || "").trim();
    const m = s.match(/^([\d.]+)/);
    return m ? m[1] : "";
  }

  /** Tunnel address without /prefix (for clipboard). */
  function tunnelIpWithoutSuffix(tunnelIp) {
    const s = String(tunnelIp ?? "").trim();
    if (!s) return "";
    const i = s.indexOf("/");
    return (i >= 0 ? s.slice(0, i) : s).trim();
  }

  function monoIpCopyCellHtml(value, displayName) {
    const raw = String(value ?? "").trim();
    const display = escapeHtml(raw);
    const copyVal = tunnelIpWithoutSuffix(raw);
    const copyBtn = copyVal
      ? `<button type="button" class="btn-quiet btn-tunnel-ip-copy" data-tunnel-ip-copy="${escapeHtml(copyVal)}" aria-label="Copy IP address" title="Copy IP (without subnet mask)"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg></button>`
      : "";
    const label = String(displayName ?? "").trim();
    const labelHtml = label ? `<span class="route-target-name">${escapeHtml(label)}</span>` : "";
    const cellClass = label ? "mono tunnel-ip-cell route-target-cell" : "mono tunnel-ip-cell";
    return `<td class="${cellClass}">${labelHtml}<span class="tunnel-ip-inner"><span class="tunnel-ip-text">${display}</span>${copyBtn}</span></td>`;
  }

  function bindTunnelIpCopyButtons(scope, setErrMsg) {
    scope.querySelectorAll("[data-tunnel-ip-copy]").forEach((b) => {
      b.addEventListener("click", async (ev) => {
        ev.stopPropagation();
        const text = b.getAttribute("data-tunnel-ip-copy") || "";
        if (!text) return;
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
            setErrMsg("Clipboard is not available in this context (try HTTPS or localhost).", true);
            return;
          }
          await navigator.clipboard.writeText(text);
          b.classList.add("is-copied");
          const prevTitle = b.title;
          b.title = "Copied";
          const prevTimer = b.getAttribute("data-copy-timer");
          if (prevTimer) window.clearTimeout(Number(prevTimer));
          const tid = window.setTimeout(() => {
            b.classList.remove("is-copied");
            b.title = prevTitle;
            b.removeAttribute("data-copy-timer");
          }, 1500);
          b.setAttribute("data-copy-timer", String(tid));
        } catch (e) {
          setErrMsg(String(e.message || e), true);
        }
      });
    });
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

  function renderPeersTable(cfg, wgStats, pingByTunnel) {
    if (wgStats === undefined) wgStats = lastPeerWgStats;
    if (pingByTunnel === undefined) pingByTunnel = lastPeerPingByTunnel;
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

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/\//g, "&#47;");
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
    stopPeersPingPolling();
    try {
      const [cfgOut, stOut] = await Promise.allSettled([api("/v1/config"), api("/v1/stats")]);
      if (cfgOut.status !== "fulfilled") {
        throw cfgOut.reason;
      }
      lastConfig = cfgOut.value;
      lastPeerWgStats = stOut.status === "fulfilled" ? stOut.value : null;
      setApiStatus(true);
      let pingMap = null;
      if (showPeersMetricsColumn()) {
        try {
          pingMap = await fetchPeerMetricsMap();
          lastPeerPingByTunnel = pingMap;
        } catch {
          lastPeerPingByTunnel = null;
        }
      } else {
        lastPeerPingByTunnel = null;
      }
      renderPeersTable(lastConfig, lastPeerWgStats, pingMap !== null ? pingMap : lastPeerPingByTunnel);
      if (showPeersMetricsColumn()) {
        peersPingTimer = setInterval(async () => {
          try {
            const m = await fetchPeerMetricsMap();
            lastPeerPingByTunnel = m;
            if (lastConfig) renderPeersTable(lastConfig, lastPeerWgStats, m);
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

  let onboardingUnlockPassStored = "";
  let onboardingBundleRebuildSeq = 0;
  let onboardingBundleDebounceTimer = null;
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
      setPeerEditorTab("fields");
      const first = $("peer-f-name");
      if (first) requestAnimationFrame(() => first.focus());
    }
    void rebuildOnboardingEncryptedBundle(false);
    void fetchPeerOverviewForModal();
  }

  function closePeerEditor() {
    peerOverviewFetchSeq++;
    if (peerOverviewDebounceTimer) {
      clearTimeout(peerOverviewDebounceTimer);
      peerOverviewDebounceTimer = null;
    }
    if (onboardingBundleDebounceTimer) {
      clearTimeout(onboardingBundleDebounceTimer);
      onboardingBundleDebounceTimer = null;
    }
    onboardingBundleRebuildSeq++;
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
    onboardingUnlockPassStored = "";
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

  /** Peer display name whose tunnel IPv4 host equals route target_ip. */
  function peerNameForTargetHost(cfg, hostIp) {
    const target = String(hostIp || "").trim();
    if (!target || !cfg || !cfg.peers) return "";
    for (const p of cfg.peers) {
      const h = tunnelToHost(p.tunnel_ip);
      if (h && h === target) {
        const n = String(p.name || "").trim();
        if (n) return n;
      }
    }
    return "";
  }

  function peerWgTopologyState(peer, st) {
    if (!peer) return "unknown";
    if (peer.disabled) return "na";
    if (!st || st.wireguard_dump_failed) return "unknown";
    const pk = String(peer.public_key || "").trim();
    const row = wgPeerPubKeyMap(st).get(pk);
    if (!row) return "unknown";
    const h = row.latest_handshake_unix;
    if (!h || h <= 0) return "off";
    const ago = Math.floor(Date.now() / 1000) - h;
    if (ago <= PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC) return "on";
    return "off";
  }

  function buildTopologyPeerSlots(cfg) {
    const routes = (cfg.forwarding && cfg.forwarding.routes) || [];
    const peers = cfg.peers || [];
    const slots = [];
    const seen = new Set();
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const host = String(r.target_ip || "").trim();
      let peer = null;
      for (const p of peers) {
        if (tunnelToHost(p.tunnel_ip) === host) {
          peer = p;
          break;
        }
      }
      const key = peer ? String(peer.public_key || "").trim() || "peer-empty-key" : "orphan:" + host;
      if (seen.has(key)) continue;
      seen.add(key);
      slots.push({ peer, orphanHost: peer ? "" : host, anchorRouteIndex: i });
    }
    return slots;
  }

  function peerSlotIndexForRoute(routes, slots, host) {
    const h = String(host || "").trim();
    for (let j = 0; j < slots.length; j++) {
      const s = slots[j];
      if (s.peer) {
        if (tunnelToHost(s.peer.tunnel_ip) === h) return j;
      } else if (s.orphanHost === h) {
        return j;
      }
    }
    return Math.max(0, slots.length - 1);
  }

  function routeTopologyProtoUpperEscaped(r) {
    const plain = routeProtoPlainText(r.proto);
    if (!plain || plain === "—") return "—";
    return escapeHtml(plain.toUpperCase());
  }

  /** Topology route card: show at most two ports, then ", ...". */
  function routeTopologyPortsDisplayEscaped(r) {
    const ports = (r.ports || []).map((x) => String(x).trim()).filter(Boolean);
    if (ports.length === 0) return escapeHtml("—");
    if (ports.length <= 2) return escapeHtml(ports.join(", "));
    return escapeHtml(ports.slice(0, 2).join(", ") + ", ...");
  }

  function routeTopologyAriaLabel(r) {
    const proto = routeProtoPlainText(r.proto);
    const portsJoined = (r.ports || []).map((x) => String(x).trim()).filter(Boolean).join(", ");
    const ports = portsJoined || "—";
    let s = "Forwarding route, " + proto + ", ports " + ports;
    if (r.disabled) s += " (disabled)";
    return escapeHtml(s);
  }

  /** Ping display for topology peer cards (right column). */
  function topologyPeerPingParts(peer, pingByTunnel) {
    if (!showPeersMetricsColumn()) {
      return { display: "—", title: "Enable peer ICMP metrics in Settings to show ping here." };
    }
    if (!peer) return { display: "—", title: "" };
    if (peer.disabled) return { display: "—", title: "Peer disabled" };
    if (!pingByTunnel) return { display: "…", title: "Loading metrics" };
    const th = tunnelHostOnly(peer.tunnel_ip);
    const row = th ? pingByTunnel.get(th) : null;
    if (!row) return { display: "—", title: "No ping data" };
    if (row.ok) return { display: String(row.latency_ms) + " ms", title: "Last ICMP ping (evuproxy metrics)" };
    const err = row.error ? String(row.error) : "unreachable";
    return { display: "—", title: err };
  }

  function topoBezierPath(x1, y1, x2, y2) {
    const dx = Math.max(40, (x2 - x1) * 0.45);
    return "M " + x1 + " " + y1 + " C " + (x1 + dx) + " " + y1 + ", " + (x2 - dx) + " " + y2 + ", " + x2 + " " + y2;
  }

  /** Fallback width when DOM measure is unavailable. */
  function estimateTopologyRouteChipWidthPx(r, routeX, peerX) {
    const proto = routeProtoPlainText(r.proto);
    const portsPlain = (r.ports || []).map((x) => String(x).trim()).filter(Boolean);
    const portsDisp =
      portsPlain.length === 0
        ? "—"
        : portsPlain.length <= 2
          ? portsPlain.join(", ")
          : portsPlain.slice(0, 2).join(", ") + ", ...";
    const protoU = proto === "—" ? "—" : proto.toUpperCase();
    const padAndGutter = 26;
    const border = 2;
    const splitGapAndVbar = 16;
    const w =
      border +
      padAndGutter +
      protoU.length * 7 +
      splitGapAndVbar +
      Math.max(portsDisp.length, 1) * 6.6 +
      padAndGutter;
    const maxW = Math.max(88, peerX - routeX - 24);
    return Math.max(68, Math.min(Math.ceil(w), maxW));
  }

  function buildTopologyRouteCardInnerHtml(r, protoEsc, portsEsc, aria, routeOutlineCls) {
    return (
      '<div class="topology-node topology-node--route' +
      (r.disabled ? " topology-node--disabled" : "") +
      routeOutlineCls +
      '" role="group" aria-label="' +
      aria +
      '"><div class="topology-route-split"><span class="topology-route-proto">' +
      protoEsc +
      '</span><span class="topology-node-vbar" aria-hidden="true"></span><span class="topology-route-ports">' +
      portsEsc +
      "</span></div></div>"
    );
  }

  function measureTopologyRouteChipWidthPx(cardInnerHtml, routeX, peerX, r) {
    const wrap = $("topology-graph-wrap");
    const maxW = Math.max(88, peerX - routeX - 24);
    if (!wrap) {
      return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
    }
    let rail = $("topology-measure-rail");
    if (!rail) {
      rail = document.createElement("div");
      rail.id = "topology-measure-rail";
      rail.className = "topology-measure-rail";
      rail.setAttribute("aria-hidden", "true");
      wrap.appendChild(rail);
    }
    rail.innerHTML = cardInnerHtml;
    const node = rail.querySelector(".topology-node--route");
    if (!node) return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
    const w = node.getBoundingClientRect().width;
    if (!(w > 1)) return estimateTopologyRouteChipWidthPx(r, routeX, peerX);
    return Math.max(52, Math.min(Math.ceil(w), maxW));
  }

  const TOPO_ZOOM_MIN = 0.25;
  const TOPO_ZOOM_MAX = 4;

  function topologyViewTransformStr() {
    return "translate(" + topologyPanX + "," + topologyPanY + ") scale(" + topologyZoomK + ")";
  }

  function applyTopologyPanZoomTransform(svg) {
    const g = svg.querySelector("#topology-pan-zoom-layer");
    if (g) g.setAttribute("transform", topologyViewTransformStr());
  }

  function resetTopologyView() {
    topologyPanX = 0;
    topologyPanY = 0;
    topologyZoomK = 1;
    topologyPanDrag = null;
    const svg = $("topology-svg");
    if (svg) {
      applyTopologyPanZoomTransform(svg);
      svg.classList.remove("topology-svg--panning");
    }
  }

  function topologySvgPointFromClient(svg, clientX, clientY) {
    if (!svg || typeof svg.createSVGPoint !== "function") return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const m = svg.getScreenCTM();
    if (!m) return null;
    try {
      return pt.matrixTransform(m.inverse());
    } catch {
      return null;
    }
  }

  function topologyEventHitsForeignObject(e) {
    if (typeof e.composedPath === "function") {
      const path = e.composedPath();
      for (let i = 0; i < path.length; i++) {
        const n = path[i];
        if (n && String(n.tagName || "").toLowerCase() === "foreignobject") return true;
      }
    }
    let t = e.target;
    let hops = 0;
    while (t && hops++ < 64) {
      if (t.tagName && String(t.tagName).toLowerCase() === "foreignobject") return true;
      t =
        t.parentElement ||
        (t.parentNode && t.parentNode.nodeType === 1 ? t.parentNode : null);
    }
    return false;
  }

  function initTopologyViewport() {
    const svg = $("topology-svg");
    if (!svg || svg.dataset.topologyViewportBound === "1") return;
    svg.dataset.topologyViewportBound = "1";

    svg.addEventListener(
      "wheel",
      (e) => {
        if (!svg.querySelector("#topology-pan-zoom-layer")) return;
        e.preventDefault();
        const p = topologySvgPointFromClient(svg, e.clientX, e.clientY);
        if (!p) return;
        const mx = p.x;
        const my = p.y;
        const scale = Math.exp(-e.deltaY * 0.002);
        let k2 = topologyZoomK * scale;
        if (k2 < TOPO_ZOOM_MIN) k2 = TOPO_ZOOM_MIN;
        if (k2 > TOPO_ZOOM_MAX) k2 = TOPO_ZOOM_MAX;
        const k1 = topologyZoomK;
        if (Math.abs(k2 - k1) < 1e-9) return;
        const r = k2 / k1;
        topologyPanX = mx - r * (mx - topologyPanX);
        topologyPanY = my - r * (my - topologyPanY);
        topologyZoomK = k2;
        applyTopologyPanZoomTransform(svg);
      },
      { passive: false }
    );

    svg.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (topologyEventHitsForeignObject(e)) return;
      if (!svg.querySelector("#topology-pan-zoom-layer")) return;
      e.preventDefault();
      const u0 = topologySvgPointFromClient(svg, e.clientX, e.clientY);
      if (!u0) return;
      topologyPanDrag = {
        pointerId: e.pointerId,
        u0,
        tx0: topologyPanX,
        ty0: topologyPanY,
      };
      try {
        svg.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      svg.classList.add("topology-svg--panning");
    });

    svg.addEventListener("pointermove", (e) => {
      if (!topologyPanDrag || e.pointerId !== topologyPanDrag.pointerId) return;
      const u = topologySvgPointFromClient(svg, e.clientX, e.clientY);
      if (!u) return;
      topologyPanX = topologyPanDrag.tx0 + (u.x - topologyPanDrag.u0.x);
      topologyPanY = topologyPanDrag.ty0 + (u.y - topologyPanDrag.u0.y);
      applyTopologyPanZoomTransform(svg);
    });

    function endPan(e) {
      if (!topologyPanDrag || e.pointerId !== topologyPanDrag.pointerId) return;
      topologyPanDrag = null;
      svg.classList.remove("topology-svg--panning");
      try {
        svg.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    }

    svg.addEventListener("pointerup", endPan);
    svg.addEventListener("pointercancel", endPan);
  }

  function renderTopologyGraph(cfg, st, activePeerKeys, pingByTunnel) {
    if (pingByTunnel === undefined) pingByTunnel = null;
    const svg = $("topology-svg");
    if (!svg) return;
    const routes = (cfg.forwarding && cfg.forwarding.routes) || [];
    const slots = buildTopologyPeerSlots(cfg);
    if (!routes.length) {
      svg.setAttribute("viewBox", "0 0 780 120");
      svg.innerHTML =
        '<title id="topology-svg-title">No routes in config</title><g id="topology-pan-zoom-layer" class="topology-pan-zoom-layer">' +
        '<rect class="topology-grid-bg" x="0" y="0" width="780" height="120" fill="#000000" fill-opacity="0" stroke="none" aria-hidden="true" />' +
        '<text x="390" y="60" text-anchor="middle" class="topology-empty-text">No routes in config</text></g>';
      applyTopologyPanZoomTransform(svg);
      return;
    }

    const rowGapSamePeer = 52;
    const rowGapNewPeer = 92;
    const peerNodeH = 58;
    const routeNodeH = 34;
    const rowH = Math.max(routeNodeH, peerNodeH);
    const pad = 36;

    const bandTop = [];
    for (let bi = 0; bi < routes.length; bi++) {
      if (bi === 0) bandTop[0] = pad;
      else {
        const pPrev = peerSlotIndexForRoute(routes, slots, routes[bi - 1].target_ip);
        const pCur = peerSlotIndexForRoute(routes, slots, routes[bi].target_ip);
        const step = pPrev === pCur ? rowGapSamePeer : rowGapNewPeer;
        bandTop[bi] = bandTop[bi - 1] + step;
      }
    }
    const lastBandTop = bandTop[routes.length - 1];
    const totalH = lastBandTop + rowH + 24;

    const srvW = 176;
    const srvX = 36;
    const srvCx = srvX + srvW;
    const srvCy = totalH / 2;
    const routeX = 268;
    const peerX = 492;
    const peerW = 200;

    function routeMidY(i) {
      return bandTop[i] + rowH / 2;
    }

    const wgIf = (cfg.wireguard && cfg.wireguard.interface) || (st && st.wireguard_interface) || "wg0";
    const wgAddr = (cfg.wireguard && cfg.wireguard.address) || "";
    const pubIf = (cfg.network && cfg.network.public_interface) || "";
    const serverLineCount = 2 + (wgAddr ? 1 : 0) + (pubIf ? 1 : 0);
    const serverNodeH = Math.max(peerNodeH, 22 + serverLineCount * 19);

    const edges = [];
    const nodes = [];
    const routeCardInners = [];
    const routeWidths = [];
    const slotMaxRouteW = new Array(slots.length).fill(0);
    const routePeerSlot = [];
    for (let ri = 0; ri < routes.length; ri++) {
      const r0 = routes[ri];
      const protoEsc0 = routeTopologyProtoUpperEscaped(r0);
      const portsEsc0 = routeTopologyPortsDisplayEscaped(r0);
      const aria0 = routeTopologyAriaLabel(r0);
      const routeOutlineCls0 = r0.disabled ? "" : " topology-node--outline-on";
      const inner0 = buildTopologyRouteCardInnerHtml(r0, protoEsc0, portsEsc0, aria0, routeOutlineCls0);
      routeCardInners.push(inner0);
      const pj0 = peerSlotIndexForRoute(routes, slots, r0.target_ip);
      routePeerSlot.push(pj0);
      const w0 = measureTopologyRouteChipWidthPx(inner0, routeX, peerX, r0);
      if (w0 > slotMaxRouteW[pj0]) slotMaxRouteW[pj0] = w0;
    }
    for (let ri = 0; ri < routes.length; ri++) {
      routeWidths.push(slotMaxRouteW[routePeerSlot[ri]]);
    }

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const routeWi = routeWidths[i];
      const routeCx = routeX + routeWi;
      const rcy = routeMidY(i);
      const dis = !!r.disabled;
      const pj = peerSlotIndexForRoute(routes, slots, r.target_ip);
      const slot = slots[pj];
      const peer = slot && slot.peer;
      const pk = peer ? String(peer.public_key || "").trim() : "";
      const stt = peer ? peerWgTopologyState(peer, st) : "unknown";

      const p1 = topoBezierPath(srvCx, srvCy, routeX, rcy);
      const pathActive = !dis && stt === "on" && !!pk && activePeerKeys.has(pk);
      let e1c;
      let e2c;
      if (dis) {
        e1c = "topo-edge topo-edge--muted";
        e2c = "topo-edge topo-edge--muted";
      } else if (pathActive) {
        e1c = "topo-edge topo-edge--on topo-edge--pulse";
        e2c = "topo-edge topo-edge--on topo-edge--pulse";
      } else {
        e1c = "topo-edge topo-edge--neutral";
        e2c = "topo-edge topo-edge--neutral";
      }
      edges.push('<path class="' + e1c + '" d="' + p1 + '" fill="none" />');

      const peerAttachY = routeMidY(slots[pj].anchorRouteIndex);
      const p2 = topoBezierPath(routeCx, rcy, peerX, peerAttachY);
      edges.push('<path class="' + e2c + '" d="' + p2 + '" fill="none" />');
    }

    const serverBody =
      '<div class="topology-node topology-node--server"><p class="topology-node-title">EvuProxy</p>' +
      '<p class="topology-node-meta mono">' +
      escapeHtml(wgIf) +
      "</p>" +
      (wgAddr ? '<p class="topology-node-detail mono">' + escapeHtml(wgAddr) + "</p>" : "") +
      (pubIf
        ? '<p class="topology-node-detail meta">wan ' + escapeHtml(pubIf) + "</p>"
        : "") +
      "</div>";

    nodes.push(
      '<foreignObject x="' +
        srvX +
        '" y="' +
        (srvCy - serverNodeH / 2) +
        '" width="' +
        srvW +
        '" height="' +
        serverNodeH +
        '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--server">' +
        serverBody +
        "</div></foreignObject>"
    );

    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      const ry = bandTop[i] + (rowH - routeNodeH) / 2;
      nodes.push(
        '<foreignObject x="' +
          routeX +
          '" y="' +
          ry +
          '" width="' +
          routeWidths[i] +
          '" height="' +
          routeNodeH +
          '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--route">' +
          routeCardInners[i] +
          "</div></foreignObject>"
      );
    }

    for (let j = 0; j < slots.length; j++) {
      const s = slots[j];
      const anchor = s.anchorRouteIndex;
      const py = bandTop[anchor] + (rowH - peerNodeH) / 2;
      const peer = s.peer;
      const stt = peer ? peerWgTopologyState(peer, st) : "unknown";
      const peerOutlineCls = stt === "on" ? " topology-node--outline-on" : "";

      const title = peer
        ? escapeHtml(String(peer.name || "").trim() || "Peer")
        : escapeHtml("Unknown target");
      const sub = peer
        ? escapeHtml(String(peer.tunnel_ip || "").trim())
        : escapeHtml(String(s.orphanHost || "").trim());
      const pingParts = topologyPeerPingParts(peer, pingByTunnel);
      const pingEsc = escapeHtml(pingParts.display);
      const pingTitleEsc = pingParts.title ? escapeHtml(pingParts.title) : "";
      const namePlain = peer ? String(peer.name || "").trim() || "Peer" : "Unknown target";
      const subPlain = peer ? String(peer.tunnel_ip || "").trim() : String(s.orphanHost || "").trim();
      const peerAria = escapeHtml(namePlain + ", " + subPlain + ", ping " + pingParts.display);

      nodes.push(
        '<foreignObject x="' +
          peerX +
          '" y="' +
          py +
          '" width="' +
          peerW +
          '" height="' +
          peerNodeH +
          '"><div xmlns="http://www.w3.org/1999/xhtml" class="topology-foreign-inner topology-foreign-inner--peer"><div class="topology-node topology-node--peer' +
          peerOutlineCls +
          '" role="group" aria-label="' +
          peerAria +
          '"><div class="topology-peer-split"><div class="topology-peer-main"><p class="topology-node-title">' +
          title +
          '</p><p class="topology-node-meta mono">' +
          sub +
          '</p></div><span class="topology-node-vbar" aria-hidden="true"></span><span class="topology-peer-ping mono"' +
          (pingTitleEsc ? ' title="' + pingTitleEsc + '"' : "") +
          ">" +
          pingEsc +
          "</span></div></div></div></foreignObject>"
      );
    }

    const online = slots.filter((s) => s.peer && peerWgTopologyState(s.peer, st) === "on").length;
    const summary =
      routes.length +
      " route(s), " +
      slots.length +
      " peer target(s), " +
      online +
      " online peer link(s)";
    svg.setAttribute("viewBox", "0 0 780 " + totalH);
    svg.innerHTML =
      '<title id="topology-svg-title">' +
      escapeHtml(summary) +
      '</title><g id="topology-pan-zoom-layer" class="topology-pan-zoom-layer"><rect class="topology-grid-bg" x="0" y="0" width="780" height="' +
      totalH +
      '" fill="#000000" fill-opacity="0" stroke="none" aria-hidden="true" /><g class="topology-edges" aria-hidden="true">' +
      edges.join("") +
      '</g><g class="topology-nodes">' +
      nodes.join("") +
      "</g></g>";
    applyTopologyPanZoomTransform(svg);
  }

  async function refreshTopologyPage() {
    if (topologyRefreshInFlight) return;
    topologyRefreshInFlight = true;
    const msg = $("topology-msg");
    if (msg) {
      msg.textContent = "";
      msg.classList.remove("err");
    }
    try {
      const [cfg, st] = await Promise.all([api("/v1/config"), api("/v1/stats")]);
      let pingByTunnel = null;
      if (showPeersMetricsColumn()) {
        try {
          pingByTunnel = await fetchPeerMetricsMap();
          lastPeerPingByTunnel = pingByTunnel;
        } catch (_) {
          pingByTunnel = lastPeerPingByTunnel;
        }
      }
      const activeKeys = new Set();
      if (st && !st.wireguard_dump_failed && Array.isArray(st.wireguard_peers)) {
        for (const row of st.wireguard_peers) {
          const pk = String(row.public_key || "").trim();
          if (!pk) continue;
          const cur = (Number(row.transfer_rx) || 0) + (Number(row.transfer_tx) || 0);
          const prev = topologyPrevPeerBytes.get(pk);
          if (prev !== undefined && cur - prev >= 128) {
            activeKeys.add(pk);
          }
          topologyPrevPeerBytes.set(pk, cur);
        }
      }
      renderTopologyGraph(cfg, st, activeKeys, pingByTunnel);
      setApiStatus(true);
    } catch (e) {
      if (msg) {
        msg.textContent = String(e.message || e);
        msg.classList.add("err");
      }
      setApiStatus(false, String(e.message || e));
    } finally {
      topologyRefreshInFlight = false;
    }
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

  function parseSourceAllowListInput(raw) {
    const s = String(raw || "").trim();
    if (!s) return [];
    return s
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  }

  function routeProtoPlainText(p) {
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
    return raw;
  }

  function formatRouteProtoCell(p) {
    const plain = routeProtoPlainText(p);
    if (plain === "—") return "—";
    if (plain === "tcp" || plain === "udp" || plain === "tcp, udp") return plain;
    return escapeHtml(plain);
  }

  function renderRoutesTable(cfg) {
    const wrap = $("routes-table-wrap");
    const routes = (cfg.forwarding && cfg.forwarding.routes) || [];

    if (!routes.length) {
      wrap.innerHTML =
        "<div class=\"empty-state\"><span class=\"empty-state-msg\">No forwarding routes yet.</span> <button type=\"button\" class=\"btn-primary\" id=\"routes-empty-add\">Add route</button></div>";
      const addBtn = $("routes-empty-add");
      if (addBtn) {
        addBtn.addEventListener("click", () => {
          const st = $("routes-add");
          if (st) st.click();
        });
      }
      return;
    }
    const rows = routes
      .map((r, i) => {
        const targetHost = String(r.target_ip || "").trim();
        const targetPeerName = peerNameForTargetHost(cfg, targetHost);
        const f = [formatRouteProtoCell(r.proto), (r.ports || []).join(", "), targetHost, targetPeerName].join(" ").toLowerCase();
        const srcList = r.source_allow_cidrs || [];
        const srcCell =
          srcList.length > 0
            ? '<td title="' +
              escapeHtml(srcList.join(", ")) +
              '"><span class="mono">' +
              escapeHtml(String(srcList.length)) +
              "</span> <span class=\"meta\">CIDR</span></td>"
            : '<td><span class="meta">any</span></td>';
        return (
          `<tr data-filter="${escapeHtml(f)}"><td>${formatRouteProtoCell(r.proto)}</td><td class="mono">${escapeHtml((r.ports || []).join(", "))}</td>` +
          monoIpCopyCellHtml(r.target_ip, targetPeerName) +
          `${srcCell}${tableDisabledToggleCell("data-route-disabled", i, !!r.disabled, "Enabled: route to " + String(r.target_ip || ""))}<td class="row-actions"><button type="button" data-route-test="${i}" class="btn-quiet">Test</button> <button type="button" data-route-edit="${i}">Edit</button> <button type="button" data-route-del="${i}" class="btn-quiet">Remove</button></td></tr>`
        );
      })
      .join("");
    wrap.innerHTML = `<table class="data"><thead><tr><th>Proto</th><th>Ports</th><th>Target</th><th>Source</th><th>Enabled</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    bindTunnelIpCopyButtons(wrap, setRoutesMsg);
    wrap.querySelectorAll("[data-route-edit]").forEach((b) => {
      b.addEventListener("click", () => openRouteEditor(+b.getAttribute("data-route-edit")));
    });
    wrap.querySelectorAll("[data-route-test]").forEach((b) => {
      b.addEventListener("click", () => runRouteProbe(+b.getAttribute("data-route-test")));
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
    applyPeersRoutesTableFilter();
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
      const sa0 = $("route-f-source-allow");
      if (sa0) sa0.value = "";
    } else {
      const r = cfg.forwarding.routes[index];
      if (!r) return;
      $("route-edit-index").value = String(index);
      $("route-editor-title").textContent = "Edit route";
      setRouteProtoCheckboxes(r.proto);
      $("route-f-ports").value = (r.ports || []).join(", ");
      $("route-f-target").value = r.target_ip || "";
      const sa = $("route-f-source-allow");
      if (sa) sa.value = (r.source_allow_cidrs || []).join(", ");
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
    const srcList = parseSourceAllowListInput(($("route-f-source-allow") && $("route-f-source-allow").value) || "");
    const entry = {
      proto,
      ports,
      target_ip: target,
      disabled: !(routeEn && routeEn.checked),
      source_allow_cidrs: srcList.length ? srcList : undefined,
    };
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
    syncGeoUnsavedIndicator();
  }

  function geoFormFromConfig(cfg) {
    const g = (cfg && cfg.geo) || {};
    const en = $("geo-f-enabled");
    const sn = $("geo-f-set-name");
    const zd = $("geo-f-zone-dir");
    const ap = $("geo-f-apply-input-allows");
    if (en) en.checked = !!g.enabled;
    if (sn) sn.value = g.set_name || "";
    if (zd) zd.value = g.zone_dir || "";
    if (ap) ap.checked = !!g.apply_to_input_allows;
    const mode = String(g.mode || "allow").toLowerCase() === "block" ? "block" : "allow";
    setGeoListMode(mode);
    geoSelectedCodes = Array.isArray(g.countries)
      ? g.countries.map((c) => String(c).trim().toLowerCase()).filter(Boolean)
      : [];
    renderGeoTags();
    syncGeoUnsavedIndicator();
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
    g.apply_to_input_allows = !!($("geo-f-apply-input-allows") && $("geo-f-apply-input-allows").checked);
    try {
      await api("/v1/config", { method: "PUT", body: JSON.stringify(cfg) });
      lastConfig = cfg;
      setGeoMsg("Saved. Review Pending changes, then Apply to host.");
      setApiStatus(true);
      refreshPendingBadge();
      syncGeoUnsavedIndicator();
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
    void refreshGeoZonesTable();
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
    lastMetricsPeersExport = null;
    try {
      const [st, mp] = await Promise.all([api("/v1/stats"), api("/v1/metrics/peers").catch(() => null)]);
      lastMetricsPeersExport = mp;
      setApiStatus(true);
      if (st.wireguard_dump_failed) {
        wgW.innerHTML =
          "<p class=\"hint\">WireGuard stats unavailable (<code>wg show</code> failed — interface missing, permission denied, or tools not installed).</p>";
      } else if (st.wireguard_peers && st.wireguard_peers.length) {
        const rows = st.wireguard_peers
          .map(
            (p) =>
              `<tr><td class="mono">${escapeHtml(trunc(p.public_key, 24))}</td><td>${escapeHtml(p.endpoint || "—")}</td><td class="mono">${escapeHtml(fmtHandshake(p.latest_handshake_unix))}</td><td>${escapeHtml(String(p.transfer_rx ?? ""))} / ${escapeHtml(String(p.transfer_tx ?? ""))}</td></tr>`
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
              `<tr><td>${escapeHtml(r.family)}</td><td>${escapeHtml(r.table)}</td><td>${escapeHtml(String(r.packets ?? ""))}</td><td>${escapeHtml(String(r.bytes ?? ""))}</td><td class="mono" style="max-width:24rem;word-break:break-all">${escapeHtml(r.line)}</td></tr>`
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
  const LOG_PREFIX_GEO = "evuproxy-geo-block";
  const LOG_PREFIX_FWD = "evuproxy-forward-drop";

  /** journalctl: "TIME HOST kernel: …"; dmesg / fallback: prefix may appear without the " kernel: " marker. */
  function parseFirewallLogLine(raw) {
    const line = String(raw || "");
    let tsDisplay = null;
    let body = line;
    const kMarker = " kernel: ";
    const kIdx = line.indexOf(kMarker);
    if (kIdx >= 0) {
      const journalMeta = line.slice(0, kIdx).trim();
      const metaParts = journalMeta.split(/\s+/);
      if (metaParts.length >= 1) tsDisplay = metaParts[0];
      body = line.slice(kIdx + kMarker.length);
    }
    let kind = "unknown";
    let rest = body.trim();
    const geoNeedle = LOG_PREFIX_GEO + ":";
    const fwdNeedle = LOG_PREFIX_FWD + ":";
    const gi = body.indexOf(geoNeedle);
    const fi = body.indexOf(fwdNeedle);
    if (gi >= 0 && (fi < 0 || gi <= fi)) {
      kind = "geo";
      rest = body.slice(gi + geoNeedle.length).trim();
    } else if (fi >= 0) {
      kind = "forward";
      rest = body.slice(fi + fwdNeedle.length).trim();
    }
    const kv = {};
    const flags = [];
    const tokens = rest.split(/\s+/).filter(Boolean);
    const kvRe = /^([A-Z][A-Z0-9]*)=(.*)$/;
    for (const t of tokens) {
      const m = t.match(kvRe);
      if (m) {
        const key = m[1];
        const val = m[2];
        if (!kv[key]) kv[key] = [];
        kv[key].push(val);
      } else {
        flags.push(t);
      }
    }
    function first(key) {
      const a = kv[key];
      return a && a[0] !== undefined ? a[0] : "";
    }
    const lenVals = kv.LEN || [];
    let lenCol = "—";
    if (lenVals.length === 1) lenCol = lenVals[0];
    else if (lenVals.length > 1) lenCol = lenVals.join(" / ");
    const kvFlat = Object.keys(kv)
      .sort()
      .flatMap((key) => kv[key].map((v) => key + "=" + v))
      .join(" ");
    const searchBlob = (
      line +
      " " +
      kvFlat +
      " " +
      flags.join(" ")
    ).toLowerCase();
    let parsedTimeMs = NaN;
    if (tsDisplay) {
      const n = Date.parse(tsDisplay);
      if (!Number.isNaN(n)) parsedTimeMs = n;
    }
    return {
      raw: line,
      tsDisplay,
      parsedTimeMs,
      kind,
      kv,
      flags,
      searchBlob,
      src: first("SRC"),
      dst: first("DST"),
      proto: first("PROTO"),
      spt: first("SPT"),
      dpt: first("DPT"),
      inn: first("IN"),
      out: first("OUT"),
      lenCol,
      flagsStr: flags.length ? flags.join(" ") : "—",
    };
  }

  function logsDatetimeLocalInputMs(inp) {
    if (!inp || !inp.value) return null;
    const t = new Date(inp.value).getTime();
    return Number.isNaN(t) ? null : t;
  }

  function filterFirewallLogEntries(entries, typeFilter, needle, rangeFromMs, rangeToMs) {
    const fromActive = rangeFromMs != null && Number.isFinite(rangeFromMs);
    const toActive = rangeToMs != null && Number.isFinite(rangeToMs);
    return entries.filter((e) => {
      if (typeFilter === "geo" && e.kind !== "geo") return false;
      if (typeFilter === "forward" && e.kind !== "forward") return false;
      if (needle && !e.searchBlob.includes(needle)) return false;
      if (fromActive || toActive) {
        if (!Number.isFinite(e.parsedTimeMs)) return false;
        if (fromActive && e.parsedTimeMs < rangeFromMs) return false;
        if (toActive && e.parsedTimeMs > rangeToMs) return false;
      }
      return true;
    });
  }

  function firewallLogKindLabel(kind) {
    if (kind === "geo") return "Geoblock";
    if (kind === "forward") return "Forward drop";
    return "—";
  }

  /** ISO 3166-1 alpha-2 → regional indicator flag emoji (empty if invalid). */
  function countryCodeToFlagEmoji(cc) {
    if (cc == null || cc === "") return "";
    const s = String(cc).trim();
    if (s.length !== 2) return "";
    const base = 0x1f1e6;
    const u = s.toUpperCase();
    const c1 = u.codePointAt(0);
    const c2 = u.codePointAt(1);
    if (c1 < 65 || c1 > 90 || c2 < 65 || c2 > 90) return "";
    return String.fromCodePoint(base + (c1 - 65), base + (c2 - 65));
  }

  function logsIpCell(ip, cc) {
    const ipPart = ip === "" ? "—" : escapeHtml(ip);
    const code = cc && String(cc).trim();
    if (!code) {
      return '<td class="mono">' + ipPart + "</td>";
    }
    const flag = countryCodeToFlagEmoji(code);
    const title = escapeHtml(code.toUpperCase());
    const flagPart = flag
      ? '<span class="logs-ip-flag" title="' + title + '">' + flag + "</span> "
      : "";
    return '<td class="mono logs-col-ip">' + flagPart + ipPart + "</td>";
  }

  function setLogsViewMode(mode) {
    logsViewMode = mode === "raw" ? "raw" : "table";
    const bTable = $("logs-view-table");
    const bRaw = $("logs-view-raw");
    if (bTable) {
      bTable.classList.toggle("is-active", logsViewMode === "table");
      bTable.setAttribute("aria-pressed", logsViewMode === "table" ? "true" : "false");
    }
    if (bRaw) {
      bRaw.classList.toggle("is-active", logsViewMode === "raw");
      bRaw.setAttribute("aria-pressed", logsViewMode === "raw" ? "true" : "false");
    }
    renderLogsView();
  }

  function clearLogsFilters() {
    clearTimeout(logsSearchDebounceTimer);
    logsSearchDebounceTimer = null;
    const typeSel = $("logs-filter-type");
    const searchInp = $("logs-search");
    const dateFrom = $("logs-date-from");
    const dateTo = $("logs-date-to");
    if (typeSel) typeSel.value = "";
    if (searchInp) searchInp.value = "";
    if (dateFrom) dateFrom.value = "";
    if (dateTo) dateTo.value = "";
    renderLogsView();
  }

  function renderLogsView() {
    const typeSel = $("logs-filter-type");
    const searchInp = $("logs-search");
    const dateFromInp = $("logs-date-from");
    const dateToInp = $("logs-date-to");
    const wrap = $("logs-table-wrap");
    const pre = $("logs-pre");
    const countEl = $("logs-count");
    const typeF = typeSel ? String(typeSel.value || "") : "";
    const needle = (searchInp && searchInp.value.trim().toLowerCase()) || "";
    const rangeFromMs = logsDatetimeLocalInputMs(dateFromInp);
    const rangeToMs = logsDatetimeLocalInputMs(dateToInp);
    const filtered = filterFirewallLogEntries(
      lastFirewallLogEntries,
      typeF,
      needle,
      rangeFromMs,
      rangeToMs
    );
    const total = lastFirewallLogEntries.length;
    if (countEl) {
      if (!total) countEl.textContent = "";
      else {
        countEl.textContent =
          "Showing " +
          filtered.length +
          " of " +
          total +
          " entr" +
          (total === 1 ? "y" : "ies");
      }
    }
    const rawMode = logsViewMode === "raw";
    if (wrap) wrap.hidden = rawMode;
    if (pre) pre.hidden = !rawMode;
    if (rawMode) {
      if (pre) {
        if (!total) pre.textContent = "No log lines returned from the host.";
        else
          pre.textContent = filtered.length
            ? filtered.map((e) => e.raw).join("\n")
            : "No lines match the current filters.";
      }
      return;
    }
    if (!wrap) return;
    if (!total) {
      wrap.innerHTML = "<p class=\"hint\">No log lines returned from the host.</p>";
      return;
    }
    if (!filtered.length) {
      wrap.innerHTML = "<p class=\"hint\">No lines match the current filters.</p>";
      return;
    }
    const rows = filtered
      .map((e) => {
        const tlabel = firewallLogKindLabel(e.kind);
        const ts = e.tsDisplay || "—";
        const cell = (v) => (v === "" ? "—" : escapeHtml(v));
        const flagsDisp = e.flagsStr === "—" ? "—" : escapeHtml(trunc(e.flagsStr, 80));
        const flagsTitle =
          e.flagsStr === "—" ? "" : escapeHtml(trunc(e.flagsStr, 400));
        return (
          "<tr>" +
          '<td class="mono">' +
          escapeHtml(ts) +
          "</td>" +
          '<td class="logs-col-type">' +
          escapeHtml(tlabel) +
          "</td>" +
          logsIpCell(e.src, e.srcCC) +
          logsIpCell(e.dst, e.dstCC) +
          "<td>" +
          cell(e.proto) +
          "</td>" +
          '<td class="mono">' +
          cell(e.spt) +
          "</td>" +
          '<td class="mono">' +
          cell(e.dpt) +
          "</td>" +
          "<td>" +
          cell(e.inn) +
          "</td>" +
          "<td>" +
          cell(e.out) +
          "</td>" +
          '<td class="mono">' +
          cell(e.lenCol) +
          "</td>" +
          '<td class="mono logs-col-flags" title="' +
          flagsTitle +
          '">' +
          flagsDisp +
          "</td>" +
          "</tr>"
        );
      })
      .join("");
    wrap.innerHTML =
      '<table class="data logs-data" aria-describedby="logs-count"><thead><tr>' +
      "<th>Time</th><th>Type</th><th>SRC</th><th>DST</th><th>Proto</th><th>SPT</th><th>DPT</th><th>IN</th><th>OUT</th><th>LEN</th><th>Flags</th>" +
      "</tr></thead><tbody>" +
      rows +
      "</tbody></table>";
  }

  function setLogsMsg(text, isErr) {
    const el = $("logs-msg");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("err", !!isErr);
  }

  async function refreshLogsPage() {
    const seq = ++logsRefreshSeq;
    const pre = $("logs-pre");
    const wrap = $("logs-table-wrap");
    const src = $("logs-source");
    const countEl = $("logs-count");
    setLogsMsg("");
    if (pre) pre.textContent = "";
    if (wrap) wrap.innerHTML = "";
    if (countEl) countEl.textContent = "";
    if (src) src.textContent = "";
    lastFirewallLogEntries = [];
    try {
      const j = await api("/v1/logs?limit=1000");
      if (seq !== logsRefreshSeq) return;
      setApiStatus(true);
      if (src) {
        src.textContent = j.source ? "Source: " + j.source : "";
      }
      const lines = j.lines || [];
      const lineGeo = j.line_geo || [];
      lastFirewallLogEntries = lines.map((raw, i) => {
        const e = parseFirewallLogLine(raw);
        const g = lineGeo[i];
        if (g && typeof g === "object") {
          if (g.src_cc) {
            e.srcCC = g.src_cc;
            e.searchBlob += " " + String(g.src_cc).toLowerCase();
          }
          if (g.dst_cc) {
            e.dstCC = g.dst_cc;
            e.searchBlob += " " + String(g.dst_cc).toLowerCase();
          }
        }
        return e;
      });
      renderLogsView();
    } catch (e) {
      if (seq !== logsRefreshSeq) return;
      setApiStatus(false, String(e.message || e));
      setLogsMsg(String(e.message || e), true);
      lastFirewallLogEntries = [];
      if (wrap) {
        wrap.innerHTML = "";
        wrap.hidden = logsViewMode === "raw";
      }
      if (pre) {
        pre.textContent = "";
        pre.hidden = logsViewMode !== "raw";
      }
      if (countEl) countEl.textContent = "";
    }
  }

  const GITHUB_RELEASES_LATEST_API =
    "https://api.github.com/repos/imevul/evuproxy/releases/latest";
  const GITHUB_RELEASES_PAGE_BASE = "https://github.com/imevul/evuproxy";
  const UPDATE_CHECK_STORAGE_KEY = "evuproxy_gh_release_check_v1";
  const UPDATE_CHECK_TTL_MS = 6 * 60 * 60 * 1000;

  function parseSemverPrefix(s) {
    const t = String(s || "")
      .trim()
      .replace(/^v/i, "");
    const m = t.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
  }

  function semverCompare(a, b) {
    if (!a || !b) return 0;
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
  }

  async function fetchLatestGitHubReleaseTag() {
    const r = await fetch(GITHUB_RELEASES_LATEST_API, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!r.ok) throw new Error("release lookup failed");
    const j = await r.json();
    const tag = String(j.tag_name || "").trim();
    if (!tag) throw new Error("no tag");
    return tag;
  }

  async function applySidebarUpdateNotice(currentVersion) {
    const note = $("sidebar-update-note");
    const link = $("sidebar-update-link");
    if (!note || !link) return;
    const cur = parseSemverPrefix(currentVersion);
    const vLow = String(currentVersion || "").trim().toLowerCase();
    if (!cur || vLow === "dev") {
      note.classList.add("is-hidden");
      return;
    }
    let latestTag = null;
    const now = Date.now();
    try {
      const raw = sessionStorage.getItem(UPDATE_CHECK_STORAGE_KEY);
      if (raw) {
        const cached = JSON.parse(raw);
        if (
          cached &&
          typeof cached.tag === "string" &&
          typeof cached.t === "number" &&
          now - cached.t < UPDATE_CHECK_TTL_MS
        ) {
          latestTag = cached.tag;
        }
      }
    } catch (_) {}
    if (!latestTag) {
      try {
        latestTag = await fetchLatestGitHubReleaseTag();
        try {
          sessionStorage.setItem(
            UPDATE_CHECK_STORAGE_KEY,
            JSON.stringify({ t: now, tag: latestTag })
          );
        } catch (_) {}
      } catch {
        note.classList.add("is-hidden");
        return;
      }
    }
    const remote = parseSemverPrefix(latestTag);
    if (!remote || semverCompare(remote, cur) <= 0) {
      note.classList.add("is-hidden");
      return;
    }
    const tagEnc = encodeURIComponent(latestTag);
    link.href = GITHUB_RELEASES_PAGE_BASE + "/releases/tag/" + tagEnc;
    const label = latestTag.replace(/^v/i, "");
    link.textContent = "New: v" + label;
    note.classList.remove("is-hidden");
  }

  async function refreshSidebarAbout() {
    const el = $("sidebar-version");
    if (!el || el.dataset.loaded === "1") return;
    try {
      const a = await api("/v1/about");
      const ver =
        a.version != null && String(a.version).trim() !== "" ? String(a.version).trim() : "—";
      el.textContent = ver;
      el.dataset.loaded = "1";
      void applySidebarUpdateNotice(ver);
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

  async function peerBundleEncryptedBytes(passphraseStr, wgParams) {
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
    if (onboardingBundleDebounceTimer) clearTimeout(onboardingBundleDebounceTimer);
    onboardingBundleDebounceTimer = setTimeout(() => {
      onboardingBundleDebounceTimer = null;
      void rebuildOnboardingEncryptedBundle(forceNewUnlock);
    }, onboardingBundleDebounceMs);
  }

  async function rebuildOnboardingEncryptedBundle(forceNewUnlock) {
    const seq = ++onboardingBundleRebuildSeq;
    const sn = $("onboard-bundle-snippet-cmd");
    if (!sn) return;
    const r = peerOnboardWireGuardParams();
    if (!r.ok) {
      if (seq !== onboardingBundleRebuildSeq) return;
      if (forceNewUnlock) onboardingUnlockPassStored = "";
      clearOnboardingBundleScriptPanels();
      return;
    }
    try {
      if (forceNewUnlock || !onboardingUnlockPassStored) {
        onboardingUnlockPassStored = randomUnlockPassphraseHex();
      }
      const bytes = await peerBundleEncryptedBytes(onboardingUnlockPassStored, r);
      if (seq !== onboardingBundleRebuildSeq) return;
      const blobB64 = u8ToB64(bytes);
      sn.textContent = buildPeerTwoLineSnippet(onboardingUnlockPassStored, blobB64);
    } catch (e) {
      if (seq !== onboardingBundleRebuildSeq) return;
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
      if (onboardingBundleDebounceTimer) clearTimeout(onboardingBundleDebounceTimer);
      onboardingBundleDebounceTimer = null;
      void rebuildOnboardingEncryptedBundle(false);
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

  applyContentMaxWidth(getContentWidthPreset());
  const contentWidthSel = $("settings-content-width");
  if (contentWidthSel) {
    contentWidthSel.addEventListener("change", () => setContentWidthPreset(contentWidthSel.value));
  }
  syncContentWidthSelect();

  function closeContextHelpModal() {
    const m = $("context-help-modal");
    if (m) m.classList.add("is-hidden");
    const bd = $("context-help-body");
    if (bd) bd.innerHTML = "";
  }

  document.body.addEventListener("click", (ev) => {
    const trig = ev.target.closest("button[data-help-template]");
    if (!trig || trig.closest("#context-help-modal")) return;
    const tid = trig.getAttribute("data-help-template");
    if (!tid) return;
    const tmpl = document.getElementById(tid);
    const modal = $("context-help-modal");
    const bd = $("context-help-body");
    const titleEl = $("context-help-modal-title");
    if (!tmpl || !tmpl.content || !modal || !bd || !titleEl) return;
    ev.preventDefault();
    bd.innerHTML = "";
    bd.appendChild(tmpl.content.cloneNode(true));
    const ht = trig.getAttribute("data-help-title");
    titleEl.textContent = ht && String(ht).trim() ? String(ht).trim() : "Help";
    modal.classList.remove("is-hidden");
  });
  const ctxHelpClose = $("context-help-close");
  if (ctxHelpClose) ctxHelpClose.addEventListener("click", closeContextHelpModal);
  const ctxHelpBd = $("context-help-backdrop");
  if (ctxHelpBd) ctxHelpBd.addEventListener("click", closeContextHelpModal);

  const gSearch = $("global-table-search");
  if (gSearch) {
    gSearch.addEventListener("input", () => applyPeersRoutesTableFilter());
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      closeShortcutsModal();
      return;
    }
    if (ev.key === "/" && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) return;
      ev.preventDefault();
      if (gSearch) gSearch.focus();
      return;
    }
    const helpKey = ev.key === "?" || (ev.shiftKey && ev.key === "/");
    if (helpKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const tag = (ev.target && ev.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || ev.target?.isContentEditable) return;
      ev.preventDefault();
      const sm = $("shortcuts-modal");
      if (sm) sm.classList.remove("is-hidden");
    }
  });

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
      const lat = $("settings-metrics-collection");
      const p = await api("/v1/preferences", {
        method: "PUT",
        body: JSON.stringify({
          peer_tunnel_subnet_cidr: cidrRaw,
          wireguard_server_endpoint: epRaw,
          metrics_collection_enabled: !!(lat && lat.checked),
        }),
      });
      lastUIPrefs = {
        peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
        wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
        metrics_collection_enabled: !!p.metrics_collection_enabled,
      };
      if (msg) {
        msg.textContent = "Preferences saved on server.";
        if (!epRaw) {
          msg.textContent += " Tip: add WireGuard server endpoint (host:port) for client snippets.";
        }
      }
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
            lastConfig = await api("/v1/config");
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

  function closeShortcutsModal() {
    const m = $("shortcuts-modal");
    if (m) m.classList.add("is-hidden");
  }

  const shortcutsClose = $("shortcuts-modal-close");
  if (shortcutsClose) shortcutsClose.addEventListener("click", closeShortcutsModal);
  const shortcutsBackdrop = document.querySelector("#shortcuts-modal .modal-backdrop");
  if (shortcutsBackdrop) shortcutsBackdrop.addEventListener("click", closeShortcutsModal);

  function openConfigUploadModal() {
    const m = $("config-upload-modal");
    if (m) m.classList.remove("is-hidden");
  }

  function closeConfigUploadModal() {
    configUploadDraft = null;
    const m = $("config-upload-modal");
    if (m) m.classList.add("is-hidden");
    const am = $("config-upload-apply-msg");
    if (am) {
      am.textContent = "";
      am.classList.remove("err");
    }
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
        configUploadDraft = parsed;
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
      if (!configUploadDraft) {
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
        await api("/v1/config", { method: "PUT", body: JSON.stringify(configUploadDraft) });
        lastConfig = configUploadDraft;
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

  const evCsv = $("overview-events-export-csv");
  if (evCsv) {
    evCsv.addEventListener("click", () => {
      downloadTextFile("evuproxy-events.csv", eventsToCsv(lastEventsForExport), "text/csv;charset=utf-8");
    });
  }

  const statsExport = $("stats-export-metrics-csv");
  if (statsExport) {
    statsExport.addEventListener("click", () => {
      if (!lastMetricsPeersExport) {
        setStatsMsg("Refresh Stats first (no metrics data).", true);
        return;
      }
      downloadTextFile("evuproxy-metrics-peers.csv", metricsPeersToCsv(lastMetricsPeersExport), "text/csv;charset=utf-8");
    });
  }

  $("peers-refresh").addEventListener("click", refreshPeersPage);
  const peerTabFieldsBtn = $("peer-tab-fields-btn");
  const peerTabOnboardBtn = $("peer-tab-onboard-btn");
  if (peerTabFieldsBtn)
    peerTabFieldsBtn.addEventListener("click", () => setPeerEditorTab("fields"));
  if (peerTabOnboardBtn)
    peerTabOnboardBtn.addEventListener("click", () => setPeerEditorTab("onboard"));
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
    if (modal) {
      modal.classList.remove("is-hidden");
      setPeerEditorTab("fields");
    }
    try {
      const kp = await generatePeerKeypairBrowser();
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

  $("routes-refresh").addEventListener("click", refreshRoutesPage);
  initTopologyViewport();
  const topoRef = $("topology-refresh");
  if (topoRef) topoRef.addEventListener("click", () => void refreshTopologyPage());
  const topoCenter = $("topology-center");
  if (topoCenter) topoCenter.addEventListener("click", resetTopologyView);
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
  const geoEn = $("geo-f-enabled");
  if (geoEn) geoEn.addEventListener("change", syncGeoUnsavedIndicator);
  const geoSn = $("geo-f-set-name");
  if (geoSn) geoSn.addEventListener("input", syncGeoUnsavedIndicator);
  const geoZd = $("geo-f-zone-dir");
  if (geoZd) geoZd.addEventListener("input", syncGeoUnsavedIndicator);
  const geoApplyInputAllows = $("geo-f-apply-input-allows");
  if (geoApplyInputAllows) geoApplyInputAllows.addEventListener("change", syncGeoUnsavedIndicator);
  const geoModeBlock = $("geo-mode-block");
  const geoModeAllow = $("geo-mode-allow");
  if (geoModeBlock) {
    geoModeBlock.addEventListener("click", () => {
      setGeoListMode("block");
      syncGeoUnsavedIndicator();
    });
  }
  if (geoModeAllow) {
    geoModeAllow.addEventListener("click", () => {
      setGeoListMode("allow");
      syncGeoUnsavedIndicator();
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
  const routeProbeModal = $("route-probe-modal");
  const routeProbeBackdrop = routeProbeModal && routeProbeModal.querySelector(".modal-backdrop");
  if (routeProbeBackdrop) routeProbeBackdrop.addEventListener("click", closeRouteProbeModal);
  const routeProbeRun = $("route-probe-run");
  if (routeProbeRun) {
    routeProbeRun.addEventListener("click", () => {
      if (!routeProbePending) return;
      const idx = routeProbePending.index;
      const set = routeProbePending.portsSet;
      const inp = $("route-probe-port-input");
      const port = Math.floor(+(inp && inp.value));
      if (!Number.isFinite(port) || !set.has(port)) {
        setRoutesMsg("Enter a port that belongs to this route.", true);
        return;
      }
      closeRouteProbeModal();
      void runRouteProbeWithPort(idx, port);
    });
  }
  const routeProbeCancel = $("route-probe-cancel");
  if (routeProbeCancel) routeProbeCancel.addEventListener("click", closeRouteProbeModal);
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
    const chHelp = $("context-help-modal");
    if (chHelp && !chHelp.classList.contains("is-hidden")) {
      closeContextHelpModal();
      ev.preventDefault();
      return;
    }
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
    const rpm = $("route-probe-modal");
    if (rpm && !rpm.classList.contains("is-hidden")) {
      closeRouteProbeModal();
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
  const logsFilterType = $("logs-filter-type");
  if (logsFilterType) logsFilterType.addEventListener("change", () => renderLogsView());
  const logsDateFrom = $("logs-date-from");
  const logsDateTo = $("logs-date-to");
  function bindLogsDatetimeFilter(inp) {
    if (!inp) return;
    inp.addEventListener("change", () => renderLogsView());
    inp.addEventListener("input", () => renderLogsView());
  }
  bindLogsDatetimeFilter(logsDateFrom);
  bindLogsDatetimeFilter(logsDateTo);
  const logsSearch = $("logs-search");
  if (logsSearch) {
    logsSearch.addEventListener("input", () => {
      clearTimeout(logsSearchDebounceTimer);
      logsSearchDebounceTimer = setTimeout(() => renderLogsView(), 220);
    });
  }
  const logsFilterClear = $("logs-filter-clear");
  if (logsFilterClear) logsFilterClear.addEventListener("click", () => clearLogsFilters());
  const logsViewTable = $("logs-view-table");
  const logsViewRaw = $("logs-view-raw");
  if (logsViewTable) logsViewTable.addEventListener("click", () => setLogsViewMode("table"));
  if (logsViewRaw) logsViewRaw.addEventListener("click", () => setLogsViewMode("raw"));

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
      const kp = await generatePeerKeypairBrowser();
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

  function extractOnboardConfFromOutput() {
    const out = ($("onboard-out") && $("onboard-out").textContent) || "";
    const idx = out.indexOf("[Interface]");
    if (idx < 0) return "";
    return out.slice(idx).trim();
  }

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
      onboardingUnlockPassStored = "";
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
