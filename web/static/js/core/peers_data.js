import { state } from "./state.js";
import { api } from "./api.js";

/** Handshake age at or below this (seconds) counts as "online". */
export const PEER_ONLINE_MAX_HANDSHAKE_AGE_SEC = 180;

export function showPeersMetricsColumn() {
  return !!state.lastUIPrefs.metrics_collection_enabled;
}

export async function fetchPeerMetricsMap() {
  const body = await api("/v1/metrics/peers");
  const m = new Map();
  for (const row of body.peers || []) {
    const tip = String(row.tunnel_ip || "").trim();
    if (tip) m.set(tip, row);
  }
  return m;
}

export function formatDashboardMinAvgMax(block, collectionDisabled) {
  if (block && typeof block.min_ms === "number" && typeof block.avg_ms === "number" && typeof block.max_ms === "number") {
    return block.min_ms + " / " + block.avg_ms + " / " + block.max_ms + " ms";
  }
  if (collectionDisabled) return "Collection off";
  return "—";
}

export function wgPeerPubKeyMap(st) {
  const m = new Map();
  if (!st || !Array.isArray(st.wireguard_peers)) return m;
  for (const row of st.wireguard_peers) {
    const k = String(row.public_key || "").trim();
    if (k) m.set(k, row);
  }
  return m;
}
