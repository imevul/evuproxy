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

/*
 * Motion is skipped for anything driven by the keyboard: at that speed it only
 * delays the next key press.
 */
let keyboardDriven = false;
document.addEventListener("keydown", () => { keyboardDriven = true; }, true);
document.addEventListener("pointerdown", () => { keyboardDriven = false; }, true);

export function lastInputWasKeyboard() {
  return keyboardDriven;
}

/**
 * Fades a removed row before the table re-renders without it. Rows below then
 * move up at once: height is deliberately not animated.
 */
export async function fadeOutRow(tr) {
  if (!tr || !tr.isConnected || keyboardDriven) return;
  tr.classList.add("is-row-leaving");
  // A re-render cancels the transition, which rejects `finished`; the row is gone either way.
  await Promise.allSettled(tr.getAnimations().map((a) => a.finished));
}

/** Before a token exists nothing has failed, so this reads neutral rather than as an error. */
export function setApiNotConnected() {
  const el = $("api-status");
  if (!el) return;
  if (el.textContent !== "Not connected") el.textContent = "Not connected";
  el.classList.remove("evu-pill--ok", "evu-pill--err");
  el.title = "No API token in this browser";
}

export function setApiStatus(ok, detail) {
  const el = $("api-status");
  if (!el) return;
  const text = ok ? "API OK" : "API error";
  // This is a live region and the poll re-runs every few seconds. Only touch it
  // when the state actually flips, or screen readers announce "API OK" forever.
  if (el.textContent !== text) {
    el.textContent = text;
    el.classList.remove("evu-pill--ok", "evu-pill--err");
    el.classList.add(ok ? "evu-pill--ok" : "evu-pill--err");
  }
  if (detail) el.title = detail;
}

/*
 * Field-level validation state.
 *
 * Validation used to be signalled only by a message at the bottom of the form,
 * which never says which control is wrong and is not associated with any of
 * them. These tie the message to the offending field so it is announced when
 * focus lands there, and mark the field itself as invalid.
 */

/** Fields currently marked invalid, keyed by the message element describing them. */
const invalidFields = new WeakMap();

/** Drops the invalid state from whichever field `msgEl` last described. */
export function clearFieldInvalid(msgEl) {
  if (!msgEl) return;
  const prev = invalidFields.get(msgEl);
  if (!prev) return;
  prev.removeAttribute("aria-invalid");
  const described = (prev.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter((id) => id && id !== msgEl.id)
    .join(" ");
  if (described) prev.setAttribute("aria-describedby", described);
  else prev.removeAttribute("aria-describedby");
  invalidFields.delete(msgEl);
}

/**
 * Marks `field` invalid, points it at `msgEl` for the reason, and focuses it.
 * Focusing is the point: the operator should land on the control to fix, not
 * have to hunt for it after reading a message elsewhere in the dialog.
 */
export function markFieldInvalid(msgEl, field) {
  clearFieldInvalid(msgEl);
  if (!msgEl || !field || !msgEl.id) return;
  field.setAttribute("aria-invalid", "true");
  const existing = (field.getAttribute("aria-describedby") || "")
    .split(/\s+/)
    .filter(Boolean);
  if (!existing.includes(msgEl.id)) existing.push(msgEl.id);
  field.setAttribute("aria-describedby", existing.join(" "));
  invalidFields.set(msgEl, field);
  field.focus();
}

/** Applies the toolbar filter tied to the table in `wrapId`. */
export function applyTableFilter(wrapId) {
  const input = document.querySelector(`.table-filter[data-filter-table="${wrapId}"]`);
  const q = (input && input.value.trim().toLowerCase()) || "";
  document.querySelectorAll(`#${wrapId} tbody tr[data-filter]`).forEach((tr) => {
    const h = tr.getAttribute("data-filter") || "";
    tr.classList.toggle("is-filter-hidden", !!q && !h.includes(q));
  });
}

/** Message inside an editor dialog; the page's own message sits behind the backdrop. */
export function setEditorMsg(id, text, field) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("err", !!text);
  if (field) markFieldInvalid(el, field);
  else clearFieldInvalid(el);
}

/*
 * A failed row switch reports under its own row. The tables re-render from config
 * (the peers table on every ping poll), so the error lives here rather than in the
 * DOM, or the next render would dismiss it.
 */
const rowErrors = new Map();

export function setRowError(dataAttr, index, message) {
  rowErrors.set(dataAttr, { index, message });
}

export function clearRowError(dataAttr) {
  rowErrors.delete(dataAttr);
}

export function rowErrorHtml(dataAttr, index, colspan) {
  const err = rowErrors.get(dataAttr);
  if (!err || err.index !== index) return "";
  return `<tr class="row-error"><td colspan="${colspan}"><div class="msg err" role="alert">${escapeHtml(err.message)}</div></td></tr>`;
}

/**
 * Re-rendering a table destroys the switch that was just used, dropping keyboard
 * users to the top of the document. Skipped if focus has since moved somewhere real.
 * If that row is gone (it was last, and removed elsewhere), the new last row takes focus.
 */
export function restoreRowSwitchFocus(wrap, dataAttr, index) {
  if (document.activeElement && document.activeElement !== document.body) return;
  if (!wrap) return;
  const inp = wrap.querySelector(`input[${dataAttr}="${index}"]`) || [...wrap.querySelectorAll(`input[${dataAttr}]`)].pop();
  if (inp) inp.focus();
}

export function tableDisabledToggleCell(dataAttr, index, disabled, ariaLabel) {
  const ch = disabled ? "" : " checked";
  return (
    `<td class="cell-disabled-toggle"><label class="evu-switch toggle-switch" aria-label="${escapeHtml(ariaLabel)}">` +
    `<input type="checkbox" class="evu-switch__input toggle-switch-input" ${dataAttr}="${index}"${ch} />` +
    `<span class="evu-switch__track toggle-switch-track" aria-hidden="true"></span>` +
    `</label></td>`
  );
}

function copyButtonHtml(value, ariaLabel, title) {
  return `<button type="button" class="evu-btn evu-btn--outline btn-tunnel-ip-copy" data-tunnel-ip-copy="${escapeHtml(value)}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(title)}"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg></button>`;
}

/** A public key on one line, shortened; the copy button and the hover both give the whole key. */
export function publicKeyCellHtml(value, peerName) {
  const raw = String(value ?? "").trim();
  if (!raw) return '<td class="mono">—</td>';
  const label = "Copy public key" + (peerName ? " of " + peerName : "");
  return `<td class="mono public-key-cell"><span class="tunnel-ip-inner"><span class="public-key-text" title="${escapeHtml(raw)}">${escapeHtml(trunc(raw, 20))}</span>${copyButtonHtml(raw, label, "Copy public key")}</span></td>`;
}

export function monoIpCopyCellHtml(value, displayName) {
  const raw = String(value ?? "").trim();
  const display = escapeHtml(raw);
  const copyVal = tunnelIpWithoutSuffix(raw);
  const copyBtn = copyVal ? copyButtonHtml(copyVal, "Copy IP address", "Copy IP (without subnet mask)") : "";
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
