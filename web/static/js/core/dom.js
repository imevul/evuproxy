import { tunnelIpWithoutSuffix } from "./net.js";

export const $ = (id) => document.getElementById(id);

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\//g, "&#47;");
}

export function trunc(s, n) {
  s = String(s || "");
  if (s.length <= n) return s;
  return s.slice(0, Math.floor(n / 2)) + "…" + s.slice(-Math.floor(n / 3));
}

export function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function setApiStatus(ok, detail) {
  const el = $("api-status");
  if (!el) return;
  el.textContent = ok ? "API OK" : "API error";
  el.classList.remove("pill-muted", "pill-ok", "pill-err");
  el.classList.add(ok ? "pill-ok" : "pill-err");
  if (detail) el.title = detail;
}

export function applyPeersRoutesTableFilter() {
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

export function tableDisabledToggleCell(dataAttr, index, disabled, ariaLabel) {
  const ch = disabled ? "" : " checked";
  return (
    `<td class="cell-disabled-toggle"><label class="toggle-switch" aria-label="${escapeHtml(ariaLabel)}">` +
    `<input type="checkbox" class="toggle-switch-input" ${dataAttr}="${index}"${ch} />` +
    `<span class="toggle-switch-track" aria-hidden="true"><span class="toggle-switch-thumb"></span></span>` +
    `</label></td>`
  );
}

export function monoIpCopyCellHtml(value, displayName) {
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

export function bindTunnelIpCopyButtons(scope, setErrMsg) {
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

function csvEscapeCell(s) {
  const t = String(s ?? "");
  if (/[",\n\r]/.test(t)) return '"' + t.replace(/"/g, '""') + '"';
  return t;
}

export function eventsToCsv(events) {
  const rows = [["ts", "event", "detail", "error_code"]];
  for (const e of events || []) {
    rows.push([e.ts || "", e.event || "", e.detail || "", e.error_code || ""]);
  }
  return rows.map((r) => r.map(csvEscapeCell).join(",")).join("\n") + "\n";
}

export function metricsPeersToCsv(data) {
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

export function clientIPSourceLabel(src) {
  if (src === "direct") return "direct";
  if (src === "xff") return "via proxy header";
  return "unknown";
}

function readRateLimitField(id, max) {
  const el = $(id);
  if (!el) return 0;
  const raw = String(el.value || "").trim();
  if (raw === "") return 0;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  if (max > 0 && n > max) return max;
  return n;
}

export function writeRateLimitFields(prefix, rl) {
  const o = rl || {};
  if (prefix === "route") {
    const set = (suffix, val) => {
      const el = $("route-f-rate-" + suffix);
      if (el) el.value = val > 0 ? String(val) : "";
    };
    set("tcp-syn", o.tcp_syn_per_second || 0);
    set("max-conn", o.max_conn_per_ip || 0);
    set("udp", o.udp_per_second || 0);
    return;
  }
  const tcp = $("geo-f-rate-tcp-syn");
  if (tcp) tcp.value = o.tcp_syn_per_second > 0 ? String(o.tcp_syn_per_second) : "";
  const mc = $("geo-f-rate-max-conn");
  if (mc) mc.value = o.max_conn_per_ip > 0 ? String(o.max_conn_per_ip) : "";
  const udp = $("geo-f-rate-udp");
  if (udp) udp.value = o.udp_per_second > 0 ? String(o.udp_per_second) : "";
}

export function readRateLimitFromForm(prefix) {
  if (prefix === "route") {
    const tcp = readRateLimitField("route-f-rate-tcp-syn", 10000);
    const mc = readRateLimitField("route-f-rate-max-conn", 65535);
    const udp = readRateLimitField("route-f-rate-udp", 100000);
    if (!tcp && !mc && !udp) return null;
    const rl = {};
    if (tcp) rl.tcp_syn_per_second = tcp;
    if (mc) rl.max_conn_per_ip = mc;
    if (udp) rl.udp_per_second = udp;
    return rl;
  }
  const tcp = readRateLimitField("geo-f-rate-tcp-syn", 10000);
  const mc = readRateLimitField("geo-f-rate-max-conn", 65535);
  const udp = readRateLimitField("geo-f-rate-udp", 100000);
  if (!tcp && !mc && !udp) return null;
  const rl = {};
  if (tcp) rl.tcp_syn_per_second = tcp;
  if (mc) rl.max_conn_per_ip = mc;
  if (udp) rl.udp_per_second = udp;
  return rl;
}
