# Documentation

Operator-focused reference (the main [README](../README.md) is the quick entry point).

| Document | Contents |
| -------- | -------- |
| [`config.yaml` reference](config.md) | Full schema: wireguard, network, forwarding, geo, crowdsec, input_allows, peers, applied snapshots; **WireGuard vs systemd-networkd/netplan** footgun and recovery |
| [Local HTTP API](http-api.md) | Optional install-time enable, `EVUPROXY_INSTALL_API`, manual non-root service, bind address, auth, CORS, endpoints |
| [Web UI](web-ui.md) | Docker UI, dev stack with mock API |
| [Security and privacy](security-and-privacy.md) | Telemetry, sensitive data, token storage, firewall / geo / reload notes |
| [Third-party data](third-party-data.md) | IPDeny attribution, usage, Copyrights.txt |

Project working notes (roadmap, spec) live under [`local_docs/`](../local_docs/). **Feature sprint task lists** (dated chunks aligned with the backlog plan) are in [`local_docs/features/`](../local_docs/features/).
