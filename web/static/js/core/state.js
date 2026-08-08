/* Shared UI constants (browser storage keys and defaults). */
export const endpointKey = "evuproxy_onboard_endpoint";
export const peerSubnetKey = "evuproxy_peer_subnet_cidr";
export const defaultPeerSubnetCidr = "10.100.0.0/24";
export const advancedSettingsKey = "evuproxy_advanced_settings";
export const contentWidthKey = "evuproxy_content_width";
export const contentWidthCssValues = {
  small: "900px",
  medium: "1200px",
  large: "1400px",
  full: "100%",
};

/** Mutable cross-module UI state (formerly module-level `let` variables in the pre-split single-file script). */
export const state = {
  lastOverview: null,
  lastConfig: null,
  /** True only after a successful GET /v1/overview with the current token (or unset token → false). */
  apiConnectionOk: false,
  /** Last /v1/stats response for peer online/offline column (null if unavailable). */
  lastPeerWgStats: null,
  /** Map tunnel IPv4 host -> last /v1/metrics/peers row; null if not fetched. */
  lastPeerPingByTunnel: null,
  peerOverviewFetchSeq: 0,
  peerOverviewDebounceTimer: null,
  /** Ignores stale results when multiple refreshOverviewPage runs overlap (navigate + save-token, etc.). */
  overviewRefreshSeq: 0,

  /** Parsed firewall log lines from last successful GET /v1/logs (client-side filter/table). */
  lastFirewallLogEntries: [],
  logsViewMode: "table",
  logsSearchDebounceTimer: null,
  /** Ignores stale responses when multiple refreshLogsPage calls overlap. */
  logsRefreshSeq: 0,

  overviewEventsTimer: null,
  /** Refreshes the Peer ICMP latency card (chart + aggregates) while Overview is visible. */
  overviewLatencyPollTimer: null,
  overviewLatencyPollSeq: 0,
  topologyPollTimer: null,
  /** Last events list from GET /v1/events (for CSV export). */
  lastEventsForExport: [],
  /** Query string from hash for ?peer= / ?route= highlighting */
  hashNavParams: new URLSearchParams(),

  /** WireGuard transfer_rx+transfer_tx totals per public_key for topology edge animation */
  topologyPrevPeerBytes: new Map(),
  topologyRefreshInFlight: false,
  /** Pan/zoom for topology SVG (user space / viewBox coordinates). */
  topologyPanX: 0,
  topologyPanY: 0,
  topologyZoomK: 1,
  topologyPanDrag: null,

  lastUIPrefs: {
    peer_tunnel_subnet_cidr: "",
    wireguard_server_endpoint: "",
    metrics_collection_enabled: false,
  },
  uiPrefsFetched: false,
  /** null = not loaded this session; string = last GET /v1/config value for public_interface. */
  settingsPublicInterfaceLoaded: null,

  routeProbePending: null,
  /** Pending parsed config from file upload (replace flow). */
  configUploadDraft: null,
  /** Last /v1/metrics/peers response for CSV export on Stats page. */
  lastMetricsPeersExport: null,

  /** Signature of the lockout risks currently shown on Pending changes. */
  pendingValidateSig: "",
  /** Signature the operator actually acknowledged; Apply requires the two to match. */
  pendingLockoutAckSig: "",
  confirmModalCallback: null,

  peersPingTimer: null,

  onboardingUnlockPassStored: "",
  onboardingBundleRebuildSeq: 0,
  onboardingBundleDebounceTimer: null,

  lastPendingBaseline: "",
  lastPendingNew: "",

  geoCountryCatalog: null,
  /** @type {Map<string, { code: string, name: string }>} */
  geoCountryByCode: new Map(),
  geoSelectedCodes: [],
  /** @type {Set<string>} */
  geoModalDraft: new Set(),
};
