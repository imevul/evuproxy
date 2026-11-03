# End-to-end tests on a real kernel

Runs the real `evuproxy reload` and `scripts/peer-install.sh` with real WireGuard and nftables, and sends real TCP and UDP through them. The Go tests only check the generated rules.

From the repo root, on Linux with Docker and Go 1.25+:

```bash
make e2e
```

It takes about a minute and runs automatically on every pull request and push to `main` (`.github/workflows/e2e.yml`). To run one scenario, use `devtools/e2e/run.sh smoke`. The heavier [stress test](#stress-test) is separate. It exits with the number of failed checks, or `100` if it could not run or refused to.

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

Each `scenarios/<name>.sh` gets a fresh topology and is picked up automatically. A scenario too heavy for every pull request goes in `on-demand/<name>.sh` instead, and only runs when named. `harness.sh` has the helpers:

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

Add more client addresses to `wan` with `in_ns wan ip addr add <ip>/32 dev lo`. `scenarios/smoke.sh` is the worked example. The order matters: the proxy's interface doesn't exist until the first `apply_config`, so bring the peer up after it and wait for the handshake before probing.

```bash
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
peer_up "$TUNNEL_SUBNET"
check "WireGuard handshake" wait_for_handshake
serve_tcp peer "$PEER_TUNNEL_IP" 18080
check "the forward answers" reaches "tcp-ok" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" 18080
```

## What `smoke` shows

- **Tunnel:** `evuproxy reload` creates the interface, the peer handshakes, and the tunnel survives another reload.
- **Forwards:** TCP and UDP pass once a route exists and not before, a port with no route gets no answer, and the peer sees the masqueraded source.
- **Geo:** in allow mode and block mode, the right client passes and the other doesn't, for both protocols. Turning geo off opens the forward to both again, and the tunnel stays up throughout.
- **Narrow `AllowedIPs`:** the peer's `AllowedIPs` is only the tunnel subnet and its default route stays on the LAN. The peer and a LAN host reach each other with no tunnel traffic, and forwards still work.

With `AllowedIPs = 0.0.0.0/0` the LAN stays reachable anyway, because connected routes win. The route and `AllowedIPs` checks are what fail then, not the LAN probes.

## What `policy` shows

A refusal on its own could just mean a dead service, so each one sits next to a case that passes under the same config.

- **Port maps:** a public TCP or UDP port reaches its internal port, and only the internal port has a listener, so an answer proves the translation. A range keeps its offset, and an unmapped port on the same route stays 1:1. The internal port stays closed from the WAN, even when routed straight at the peer. Lists still apply to a mapped route.
- **Deny and allow lists:** a route's allow list and deny list refuse the right clients, and deny beats allow. Neither touches other routes. The global deny list covers every route and beats a route's allow list, and lifting it lets the client back.
- **Break-glass:** a client gets past geo in allow mode and block mode, on forwards and on geo-filtered `input_allows`. It doesn't get past the global deny list or a route's allow list.
- **Geo on `input_allows`:** a blocked client stays blocked once it has used up the log limit's burst.
- **Route geo:** `inherit`, `off` and `custom` each pass and refuse the right country, under global allow and block.
- **Maintenance mode:** forwards are refused while the peer's services stay up, the tunnel and `input_allows` keep working, other proxy ports stay closed, and forwards come back afterwards.

## What `drop_counters` shows

- **Off:** with `stats.drop_counters` unset, the ruleset has no drop counters, even while traffic is being dropped.
- **On:** geo allow, geo block, the global deny list, CrowdSec, UDP rate limits and the forward catch-all each count the packets they refuse, read the way **Stats** reads them, and a client that passes isn't counted. The catch-all counts past its log limit.
- **Reload:** a reload starts the counts from zero.

## What `route_accepted` shows

Reads `route_accepted` from the real `GET /api/v1/stats`.

- **Separate routes:** two routes that share a target and an internal port each count only their own traffic, and a route with both protocols has a row for each.
- **All accepted packets:** TCP counts past the first packet of a connection, and every datagram of one UDP flow counts.
- **Accepted, not answered:** a routed port with no listener still counts.
- **Drops stay out:** global and route deny lists, geo allow and block, CrowdSec and UDP rate limits count nothing they refuse, each beside a client that passes and counts under the same config. A CrowdSec ban stops an established flow counting, and with a rate limit the accepted and dropped counts add up to everything sent.
- **Reload and saved changes:** a reload starts the counts from zero. Saved changes that aren't applied don't relabel them.
- **Prometheus:** `GET /metrics` reports the same packets and bytes as `GET /stats`, and has no samples in maintenance mode.

It doesn't send real traffic past a SYN limit or `max_conn_per_ip`. Those drop on the forward chain like the UDP limit, and the Go tests check they stay there.

## What `auto_pause` shows

On demand, with `devtools/e2e/run.sh auto_pause`. It takes about 11 minutes, because handshakes take 180 seconds to go stale. It runs the real `evuproxy serve` and reads the event log, the live `prerouting` chain and real traffic.

- **Idle peer:** with no traffic for longer than the handshake threshold, a healthy peer doesn't pause.
- **Peer gone:** the route pauses once the real handshake is stale, and `config.yaml` is untouched. Its DNAT goes without replacing the filter table. A client the route accepts gets nothing from a listener on the proxy on the paused port, and a client off the route's allowlist still reaches that listener through `input_allows`, as it does while the route runs.
- **Full Apply while paused:** the Apply puts the DNAT back, and the next probe takes it out again with no new event.
- **Restart and return:** a restart restores the DNAT on its first probe, and the route pauses again only once the threshold is reached. When the peer comes back the DNAT returns, and a UDP client that kept the same source port throughout reaches the peer.
- **ICMP fallback:** a peer that's gone doesn't answer ping, so it still pauses.

`devtools/rollback-vm` covers what this can't, because it needs systemd and reboots: confirm-or-revert. The container has no `systemd-run`, so this harness never turns on `apply.confirm`.

## What `GET /stats` costs

```bash
make e2e-stats-cost
```

Times `GET /stats`, and each `wg` and `nft` command behind it, as the geo set grows to 150,000 elements. CPU is what the server and its commands used, and peak memory is per command. It takes about three minutes and has no thresholds: it fails only if a request or reload doesn't work, or if `nft -t` changes a counter line. Each number is a `RESULT` line.

The elements are generated `/24`s with gaps between them, so auto-merge can't fold them. Real zones will vary, the numbers depend on this machine and the nftables in the container, and nothing here runs on an EvuProxy host.

## Stress test

```bash
make e2e-stress
```

Rate limits and CrowdSec drops under load, with legitimate clients running alongside. It takes a little over two minutes and needs no more than the smoke test does. All load stays inside the container: `on-demand/stress.sh` drives `loadgen/`, which only sends from `wan` through `proxy` to `peer`, and those namespaces have no route out.

It isn't part of `make e2e`, because it takes longer and depends on timing. `.github/workflows/e2e-stress.yml` runs it on demand from the Actions tab, and on pull requests that change `devtools/e2e`, the nftables generator or the ban restore. That job lists every measurement in its summary. Locally, each one is a `RESULT` line in the output: name, measured value and allowed range.

### Thresholds

They are set at the top of `on-demand/stress.sh`, and the run fails if any is missed. The limits are 20 SYN/s with a burst of 40, 100 UDP datagrams/s with a burst of 100, and 5 connections per source. Floods run for 6 seconds at ten times the limit.

| What | Allowed | Measured |
| ---- | ------- | -------- |
| Harness with no limits, 200 TCP/s and 1000 UDP/s answered | at least 99% | 100% |
| TCP flood from one source answered, where rate × time + burst is 160 | 108 to 176 | 159 |
| UDP flood from one source answered, where rate × time + burst is 700 | 540 to 770 | 699 |
| TCP flood from 20 sources answered, where the cap is 3200 | 2160 to 3520 | 3180 |
| Legitimate client beside any flood, ban or reload | at least 95% answered | 100% |
| A flood's source once it stops | at least 95% answered | 100% |
| Break-glass source flooding TCP | at least 99% answered | 100% |
| Connections or UDP flows a source gets with `max_conn_per_ip: 5`, and that stay usable | exactly 5 | 5 |
| Another source's connections while the first is at its limit | exactly 5 of 5 | 5 |
| Banned source, from 2 seconds after the ban, UDP and new TCP | 0 | 0 |
| Banned source's datagrams during a reload, at 1000/s | at most 100 | 7 to 27 |
| Banned source, from 2 seconds after that reload | 0 | 0 |
| Traffic after an unban, or after a timed ban expires | at least 95% and 99% | 100% |
| UDP at 1000/s with 10000 bans in the set | at least 99% answered | 100% |

### How much variation to expect

Almost none in the rate limits, because the kernel's token bucket is exact and the load is paced. Ten runs on an 8-core machine gave the same flood numbers every time, including three runs at once with other jobs on the machine.

The one number that moves is the reload gap, because it depends on how long `evuproxy reload` takes between replacing the table and restoring the bans. Slower CI runners may move more than this machine did, so the bands are left wider than these runs needed: 10% around floods and 5% on legitimate traffic. A failure in the baseline row means the machine couldn't carry the load, so ignore the rest of that run. A flood total outside its band with a good baseline is a real change in the rules.

### What it doesn't cover

- **CrowdSec itself.** It needs the Hub and a journal, so the scenario adds bans to `crowdsec_block_v4` directly, as the bouncer does. Deciding to ban, and the bouncer's polling, aren't tested.
- **Log volume.** Rate-limit and CrowdSec drops log every packet with no limit of their own. The kernel doesn't log from a network namespace by default, so that cost isn't measured here.
- **The `input` chain.** Forwarded traffic is measured. The same rules on `input` come after its early established accept and aren't load tested.
- **Other kernels.** It only checks the kernel it runs on. The numbers above are from 7.0 with nftables 1.0.6.
