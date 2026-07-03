import { state } from "../core/state.js";
import { $, escapeHtml, trunc, setApiStatus, downloadTextFile, metricsPeersToCsv } from "../core/dom.js";
import { api } from "../core/api.js";

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

/** Map public_key -> peer name from the loaded config ({} when config unavailable). */
function peerNamesByPublicKey(cfg) {
  const out = {};
  if (!cfg || !Array.isArray(cfg.peers)) return out;
  for (const p of cfg.peers) {
    const key = String(p.public_key || "").trim();
    const name = String(p.name || "").trim();
    if (key && name) out[key] = name;
  }
  return out;
}

export async function refreshStatsPage() {
  const wgW = $("stats-wg-wrap");
  const nftW = $("stats-nft-wrap");
  setStatsMsg("");
  state.lastMetricsPeersExport = null;
  try {
    const [st, mp] = await Promise.all([
      api("/v1/stats"),
      api("/v1/metrics/peers").catch(() => null),
      /* Fresh peer names for the WireGuard table (names before identifiers);
         keep whatever is cached if the fetch fails. */
      api("/v1/config")
        .then((cfg) => {
          state.lastConfig = cfg;
        })
        .catch(() => null),
    ]);
    state.lastMetricsPeersExport = mp;
    setApiStatus(true);
    if (st.wireguard_dump_failed) {
      wgW.innerHTML =
        "<p class=\"hint\">WireGuard stats unavailable (<code>wg show</code> failed — interface missing, permission denied, or tools not installed).</p>";
    } else if (st.wireguard_peers && st.wireguard_peers.length) {
      const names = peerNamesByPublicKey(state.lastConfig);
      const rows = st.wireguard_peers
        .map(
          (p) =>
            `<tr><td>${escapeHtml(names[String(p.public_key || "").trim()] || "—")}</td><td class="mono">${escapeHtml(trunc(p.public_key, 24))}</td><td>${escapeHtml(p.endpoint || "—")}</td><td class="mono">${escapeHtml(fmtHandshake(p.latest_handshake_unix))}</td><td>${escapeHtml(String(p.transfer_rx ?? ""))} / ${escapeHtml(String(p.transfer_tx ?? ""))}</td></tr>`
        )
        .join("");
      wgW.innerHTML = `<table class="data"><thead><tr><th>Peer</th><th>Public key</th><th>Endpoint</th><th>Handshake</th><th>RX / TX</th></tr></thead><tbody>${rows}</tbody></table>`;
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

/** One-time event wiring for this page (runs once at startup from main.js). */
export function initStatsPage() {
  const statsExport = $("stats-export-metrics-csv");
  if (statsExport) {
    statsExport.addEventListener("click", () => {
      if (!state.lastMetricsPeersExport) {
        setStatsMsg("Refresh Stats first (no metrics data).", true);
        return;
      }
      downloadTextFile("evuproxy-metrics-peers.csv", metricsPeersToCsv(state.lastMetricsPeersExport), "text/csv;charset=utf-8");
    });
  }

  $("stats-refresh").addEventListener("click", refreshStatsPage);
}
