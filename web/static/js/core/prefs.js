import { state, endpointKey, peerSubnetKey, defaultPeerSubnetCidr } from "./state.js";
import { api } from "./api.js";

export function invalidateUIPrefsCache() {
  state.uiPrefsFetched = false;
}

export function migrateFromLocalStorageIfEmpty() {
  try {
    if (!state.lastUIPrefs.peer_tunnel_subnet_cidr) {
      const s = localStorage.getItem(peerSubnetKey);
      if (s && String(s).trim()) state.lastUIPrefs.peer_tunnel_subnet_cidr = String(s).trim();
    }
    if (!state.lastUIPrefs.wireguard_server_endpoint) {
      const s = localStorage.getItem(endpointKey);
      if (s && String(s).trim()) state.lastUIPrefs.wireguard_server_endpoint = String(s).trim();
    }
  } catch (e) {
    /* ignore */
  }
}

export async function fetchUIPrefsFromServer() {
  const p = await api("/v1/preferences");
  state.lastUIPrefs = {
    peer_tunnel_subnet_cidr: (p.peer_tunnel_subnet_cidr || "").trim() || defaultPeerSubnetCidr,
    wireguard_server_endpoint: (p.wireguard_server_endpoint || "").trim(),
    metrics_collection_enabled: !!p.metrics_collection_enabled,
  };
  migrateFromLocalStorageIfEmpty();
}

export async function ensureUIPrefs() {
  if (state.uiPrefsFetched) return;
  try {
    await fetchUIPrefsFromServer();
  } catch {
    state.lastUIPrefs = { peer_tunnel_subnet_cidr: "", wireguard_server_endpoint: "", metrics_collection_enabled: false };
    migrateFromLocalStorageIfEmpty();
  }
  state.uiPrefsFetched = true;
}
