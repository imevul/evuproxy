# End-to-end tests on a real kernel

Runs the real `evuproxy reload` and `scripts/peer-install.sh` with real WireGuard and nftables, and sends real TCP and UDP through them. The Go tests only check the generated rules.

From the repo root, on Linux with Docker and Go 1.25+:

```bash
make e2e
```

It takes about a minute and runs automatically on every pull request and push to `main` (`.github/workflows/e2e.yml`). To run one scenario, use `devtools/e2e/run.sh smoke`. It exits with the number of failed checks, or `100` if it could not run or refused to.

## Never on a production host

**This test changes firewall rules.** Run it on a CI runner or a development machine. Three things keep it away from production:

- `run.sh` refuses if the machine looks like an EvuProxy host: `/etc/evuproxy/config.yaml`, `/etc/wireguard/evuproxy0.conf`, the `evuproxy0` interface or the `evuproxy.service` unit. There is no override.
- `inside.sh` refuses unless it was started by `run.sh` inside a Docker container, on the container's own network (no physical interfaces, so not `--network host`) with no firewall rules yet.
- `evuproxy` and every rule run in network namespaces created inside that container. Each run checks that the container's own namespace still has no rules or tunnel afterwards.

## What it leaves behind

The container and everything in it go away with `--rm`, and the temporary binary is deleted. What stays on the machine is the `debian:12-slim` image, and any kernel modules the test caused to load, such as `wireguard` and `nf_tables`. Loading a module adds no rules or interfaces, and the host needs a kernel with those modules available. The container gets `NET_ADMIN` and `SYS_ADMIN` for its own namespaces, runs without the AppArmor profile because `ip netns` needs to mount, and publishes no ports.

## Topology

Each box is a network namespace. None of them has a route out of the container.

```text
 wan                            proxy
 203.0.113.10  (zone xa)        eth0 192.0.2.1 ---- runs evuproxy
 198.51.100.10 (zone xb)  ----  evuproxy0 10.100.0.1/24
 192.0.2.2                         :
 198.18.0.1                        : WireGuard, through the LAN router's NAT
    |                              :
 lan                            peer
 198.18.0.2, NAT to wan         lan0 192.168.50.10, default route by the LAN
 192.168.50.1 (router)    ----  evuproxy 10.100.0.2/32
 192.168.50.20 (LAN host)       AllowedIPs 10.100.0.0/24
```

The two WAN addresses stand in for clients in two countries. Geo zones `xa` and `xb` are seeded in the zone directory, so nothing is downloaded from ipdeny.com.

## Adding a scenario

Each `scenarios/<name>.sh` gets a fresh topology and is picked up automatically. `harness.sh` has the helpers:

| Helper | What it does |
| ------ | ------------ |
| `... \| apply_config` | Reads the `forwarding`, `geo` and `input_allows` sections from stdin, adds `wireguard`, `network` and `peers`, and runs `evuproxy reload` in `proxy` |
| `peer_up "$TUNNEL_SUBNET"` | Brings the peer up with `scripts/peer-install.sh` and that `AllowedIPs` |
| `wait_for_handshake`, `tunnel_pings` | Check that the tunnel is up |
| `serve_tcp` / `serve_udp <ns> <ip> <port>` | Start a service that answers with the source address it saw |
| `tcp_reply` / `udp_reply <ns> <src> <dst> <port>` | Send one new flow and print the reply |
| `check "name" <command>` | Count a pass or a fail |
| `reaches "<text>" tcp_reply ...`, `blocked tcp_reply ...` | Assert on a reply, or on no reply |
| `in_ns <ns> <command>`, `wg_bytes <ns> <iface>` | Run something in a namespace, or read tunnel traffic |

Add more client addresses to `wan` with `in_ns wan ip addr add <ip>/32 dev lo`. `scenarios/smoke.sh` is the worked example:

```bash
peer_up "$TUNNEL_SUBNET"
serve_tcp peer "$PEER_TUNNEL_IP" 18080
apply_config <<EOF
forwarding:
  routes:
    - proto: tcp
      ports: ["18080"]
      target_ip: $PEER_TUNNEL_IP
geo:
  enabled: false
input_allows: []
EOF
check "the forward answers" reaches "tcp-ok" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" 18080
```

## What `smoke` shows

- **Tunnel:** `evuproxy reload` creates the interface, the peer handshakes, and the tunnel survives another reload.
- **Forwards:** TCP and UDP pass once a route exists and not before, a port with no route gets no answer, and the peer sees the masqueraded source.
- **Geo:** in allow mode and block mode, the right client passes and the other doesn't, for both protocols. Turning geo off opens the forward to both again, and the tunnel stays up throughout.
- **Narrow `AllowedIPs`:** the peer's `AllowedIPs` is only the tunnel subnet and its default route stays on the LAN. The peer and a LAN host reach each other with no tunnel traffic, and forwards still work.

With `AllowedIPs = 0.0.0.0/0` the LAN stays reachable anyway, because connected routes win. The route and `AllowedIPs` checks are what fail then, not the LAN probes.

`devtools/rollback-vm` covers what this can't, because it needs systemd and reboots: confirm-or-revert. The container has no `systemd-run`, so this harness never turns on `apply.confirm`.
