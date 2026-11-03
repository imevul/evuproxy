#!/bin/bash
# GET /stats route_accepted: real packets, read from the real API. Counts stay per route, cover
# established traffic, and leave out whatever a deny list, geo, CrowdSec or a rate limit drops.
# Sourced by inside.sh with a fresh topology.

PORT_TCP=18080
MAP_PUBLIC=18082 # maps to PORT_TCP, so routes 0 and 1 share a target and an internal port
PORT_UDP=15353
PORT_BOTH=15400
PORT_SILENT=15401 # routed, but nothing listens
WAN_SOURCE=192.0.2.2
TCP_OK="tcp-ok from=$PROXY_TUNNEL_IP"
UDP_OK="udp-ok from=$PROXY_TUNNEL_IP"
API=127.0.0.1:19848
METRICS=127.0.0.1:19849
R_TCP=0 R_MAPPED=1 R_UDP=2 R_BOTH=3 R_SILENT=4

# $1 other top-level sections, $2 extra lines under forwarding, $3 extra lines for route R_BOTH.
accepted_config() {
	cat <<EOF
forwarding:
${2:-}
  routes:
    - proto: tcp
      ports: ["$PORT_TCP"]
      target_ip: $PEER_TUNNEL_IP
    - proto: tcp
      ports: ["$MAP_PUBLIC"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_PUBLIC", internal: "$PORT_TCP"}]
    - proto: udp
      ports: ["$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
    - proto: both
      ports: ["$PORT_BOTH"]
      target_ip: $PEER_TUNNEL_IP
${3:-}
    - proto: udp
      ports: ["$PORT_SILENT"]
      target_ip: $PEER_TUNNEL_IP
input_allows: []
${1:-geo:
  enabled: false}
EOF
}
geo_on() {
	cat <<EOF
geo:
  enabled: true
  mode: $1
  set_name: geo_v4
  countries: ["xa"]
  zone_dir: $ZONE_DIR
EOF
}

# Not in_ns: a backgrounded function is a subshell, and kill would miss serve inside it.
ip netns exec proxy env EVUPROXY_API_TOKEN=e2e evuproxy --config /etc/evuproxy/config.yaml serve \
	--listen "$API" --metrics-listen "$METRICS" --token-file "" </dev/null >/tmp/serve-accepted.log 2>&1 &
serve_pid=$!

stats_json() {
	printf 'GET /api/v1/stats HTTP/1.0\r\nAuthorization: Bearer e2e\r\n\r\n' | in_ns proxy socat -t2 - "TCP:$API"
}
# $1 route index, $2 protocol. Prints the route's whole row.
accepted_row() {
	local json
	json=$(stats_json)
	grep -oE "\{\"route_index\":$1,[^}]*\"proto\":\"$2\"[^}]*\}" <<<"$json"
}
accepted_packets() {
	local row
	row=$(accepted_row "$1" "$2")
	[[ $row =~ \"packets\":([0-9]+) ]] && echo "${BASH_REMATCH[1]}"
}
accepted_is() {
	local got
	got=$(accepted_packets "$1" "$2")
	[ "$got" = "$3" ] || { log "  wanted $3 packets on route $1 $2, got '$got'"; return 1; }
}
accepted_at_least() {
	local got
	got=$(accepted_packets "$1" "$2")
	[ "${got:-0}" -ge "$3" ] || { log "  wanted at least $3 packets on route $1 $2, got '$got'"; return 1; }
}
metrics_text() {
	printf 'GET /metrics HTTP/1.0\r\n\r\n' | in_ns proxy socat -t2 - "TCP:$METRICS"
}
# $1 route index, $2 protocol. Both metrics carry the numbers GET /stats has for the route.
metrics_match_stats() {
	local row text packets bytes
	row=$(accepted_row "$1" "$2")
	[[ $row =~ \"packets\":([0-9]+),\"bytes\":([0-9]+) ]] || { log "  no stats row for route $1 $2"; return 1; }
	packets=${BASH_REMATCH[1]} bytes=${BASH_REMATCH[2]}
	text=$(metrics_text)$'\n'
	[[ $text == *"evuproxy_route_accepted_packets_total{route_index=\"$1\",name=\"\",proto=\"$2\"} $packets"$'\n'* ]] &&
		[[ $text == *"evuproxy_route_accepted_bytes_total{route_index=\"$1\",name=\"\",proto=\"$2\"} $bytes"$'\n'* ]] ||
		{ log "  wanted $packets packets and $bytes bytes on route $1 $2, got: $text"; return 1; }
}
# $1 how many, on one socket, so everything after the first is established traffic.
one_flow_udp() {
	in_ns wan bash -c "exec 3<>/dev/udp/$PROXY_PUBLIC_IP/$PORT_UDP; for ((i = 0; i < $1; i++)); do echo x >&3; done" 2>/dev/null
}
api_is_up() {
	local i
	for ((i = 0; i < 50; i++)); do
		[[ $(stats_json) == *route_accepted* ]] && return 0
		sleep 0.1
	done
	return 1
}
# The refused client gets nothing on either protocol, and nothing is counted.
refused_not_counted() {
	check "$2: TCP gets no answer" blocked tcp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT_BOTH"
	check "$2: UDP gets no answer" blocked udp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT_BOTH"
	check "$2: no TCP counted" accepted_is "$R_BOTH" tcp 0
	check "$2: no UDP counted" accepted_is "$R_BOTH" udp 0
}
# A client the same config lets through, so a zero above can't mean the counter is broken.
passes_and_counts() {
	check "$2: TCP passes" reaches "$TCP_OK" tcp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT_BOTH"
	check "$2: UDP passes" reaches "$UDP_OK" udp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT_BOTH"
	check "$2: TCP counted" accepted_at_least "$R_BOTH" tcp 3
	check "$2: UDP counted" accepted_is "$R_BOTH" udp 1
}

log "=== 1. Each route counts its own traffic ==="
accepted_config | apply_config || die "reload"
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
serve_tcp peer "$PEER_TUNNEL_IP" "$PORT_TCP"
serve_tcp peer "$PEER_TUNNEL_IP" "$PORT_BOTH"
serve_udp peer "$PEER_TUNNEL_IP" "$PORT_UDP"
serve_udp peer "$PEER_TUNNEL_IP" "$PORT_BOTH"
api_is_up || die "API didn't answer"
check "a route starts at zero" accepted_is "$R_TCP" tcp 0
check "a route's row says what it is" eval '[[ $(accepted_row "$R_MAPPED" tcp) == *"\"ports\":[\"$MAP_PUBLIC\"],\"target_ip\":\"$PEER_TUNNEL_IP\""* ]]'

check "TCP passes" reaches "$TCP_OK" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT_TCP"
# A rule on the route's accept would stop at the first packet of the connection.
check "TCP counts past the first packet" accepted_at_least "$R_TCP" tcp 3
check "the route sharing its target and port stays at zero" accepted_is "$R_MAPPED" tcp 0
check "UDP stays at zero" accepted_is "$R_UDP" udp 0
sleep 0.5
tcp_count=$(accepted_packets "$R_TCP" tcp)
check "the mapped route passes" reaches "$TCP_OK" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$MAP_PUBLIC"
check "the mapped route counts its own traffic" accepted_at_least "$R_MAPPED" tcp 3
check "and the unmapped one doesn't move" accepted_is "$R_TCP" tcp "$tcp_count"

log "=== 2. Established traffic counts ==="
one_flow_udp 5
check "all 5 datagrams of one flow are counted" accepted_is "$R_UDP" udp 5
check "the Prometheus metrics say the same" metrics_match_stats "$R_UDP" udp
check "for another route too" metrics_match_stats "$R_MAPPED" tcp
accepted_only=$(printf 'GET /api/v1/stats/route-accepted HTTP/1.0\r\nAuthorization: Bearer e2e\r\n\r\n' | in_ns proxy socat -t2 - "TCP:$API")
check "GET /stats/route-accepted has the route's row" eval '[[ $accepted_only == *"\"route_accepted\":[{"* && $accepted_only == *"$(accepted_row "$R_UDP" udp)"* ]]'
check "and nothing else" eval '[[ $accepted_only != *wireguard_peers* ]]'
check "the rules are in their own table, with no sets to load" eval '[[ $(in_ns proxy nft list table inet evuproxy_accepted) == *evuproxy-accepted* && $(in_ns proxy nft list table inet evuproxy_accepted) != *"set "* ]]'
check "and not in the filter table" eval '[[ $(in_ns proxy nft list table inet evuproxy) != *evuproxy-accepted* ]]'

log "=== 3. A route with both protocols has a row for each ==="
check "no traffic yet" accepted_is "$R_BOTH" tcp 0
passes_and_counts "$CLIENT_IN_ZONE" "both"

log "=== 4. Accepted doesn't mean answered ==="
check "a port nobody listens on gets no answer" blocked udp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT_SILENT"
check "but is accepted, and counted" accepted_is "$R_SILENT" udp 1

log "=== 5. Saved changes don't relabel the live counts ==="
sed -i "s/\"$PORT_UDP\"/\"15999\"/" /etc/evuproxy/config.yaml
check "the row still shows the applied ports" eval '[[ $(accepted_row "$R_UDP" udp) == *"\"ports\":[\"$PORT_UDP\"]"* ]]'
check "and its count" accepted_is "$R_UDP" udp 5

log "=== 6. A reload starts the counts again ==="
accepted_config | apply_config || die "reload"
check "back at zero" accepted_is "$R_UDP" udp 0
stats=$(stats_json)
check "accepted rules stay out of nftables_counters" eval '[[ $stats != *evuproxy-accepted* ]]'

log "=== 7. Deny lists ==="
accepted_config "" "  source_deny_cidrs: [\"$CLIENT_IN_ZONE\"]" | apply_config || die "reload with global deny"
refused_not_counted "$CLIENT_IN_ZONE" "global deny"
passes_and_counts "$CLIENT_OUT_OF_ZONE" "global deny"

accepted_config "" "" "      source_deny_cidrs: [\"$CLIENT_IN_ZONE\"]" | apply_config || die "reload with route deny"
refused_not_counted "$CLIENT_IN_ZONE" "route deny"
passes_and_counts "$CLIENT_OUT_OF_ZONE" "route deny"

log "=== 8. Geo ==="
accepted_config "$(geo_on allow)" | apply_config || die "reload with geo allow"
refused_not_counted "$CLIENT_OUT_OF_ZONE" "geo allow"
passes_and_counts "$CLIENT_IN_ZONE" "geo allow"

accepted_config "$(geo_on block)" | apply_config || die "reload with geo block"
refused_not_counted "$CLIENT_IN_ZONE" "geo block"
passes_and_counts "$CLIENT_OUT_OF_ZONE" "geo block"

log "=== 9. CrowdSec ==="
CROWDSEC='geo:
  enabled: false
crowdsec:
  enabled: true'
accepted_config "$CROWDSEC" | apply_config || die "reload with crowdsec"
in_ns proxy nft add element inet evuproxy crowdsec_block_v4 "{ $CLIENT_IN_ZONE }" || die "add ban"
refused_not_counted "$CLIENT_IN_ZONE" "crowdsec"
passes_and_counts "$CLIENT_OUT_OF_ZONE" "crowdsec"

# A ban in the middle of a flow: these packets are established, and the drop is on forward. A
# counter placed ahead of that drop would go on counting them.
in_ns wan bash -c "exec 3<>/dev/udp/$PROXY_PUBLIC_IP/$PORT_UDP; for i in 1 2 3; do echo x >&3; done; sleep 2; for i in 1 2 3 4; do echo x >&3; done" 2>/dev/null &
flow_pid=$!
sleep 1
check "before the ban the flow is counted" accepted_is "$R_UDP" udp 3
in_ns proxy nft add element inet evuproxy crowdsec_block_v4 "{ $WAN_SOURCE }" || die "add ban mid-flow"
wait "$flow_pid"
sleep 0.2
check "the same flow stops counting once banned" accepted_is "$R_UDP" udp 3
in_ns proxy nft delete element inet evuproxy crowdsec_block_v4 "{ $WAN_SOURCE }" || die "lift ban"

log "=== 10. Rate limits ==="
accepted_config "geo:
  enabled: false
stats:
  drop_counters: true" "  rate_limit:
    udp_per_second: 1" | apply_config || die "reload with rate limit"
in_ns wan bash -c "for i in {1..50}; do echo x >/dev/udp/$PROXY_PUBLIC_IP/$PORT_UDP; done" 2>/dev/null
# 50 datagrams at once, with a burst of 2. A slow runner earns a token or two along the way.
rate_limit_splits_the_traffic() {
	local rules accepted dropped
	accepted=$(accepted_packets "$R_UDP" udp)
	rules=$(in_ns proxy nft list chain inet evuproxy forward)
	rules=$(grep -F "udp dport $PORT_UDP update @ratelimit_udp_v4" <<<"$rules")
	[[ $rules =~ counter\ packets\ ([0-9]+) ]] && dropped=${BASH_REMATCH[1]}
	log "  accepted $accepted, dropped ${dropped:-?} of 50"
	[ "${accepted:-99}" -le 10 ] && [ "${accepted:-0}" -ge 2 ] && [ "$((accepted + ${dropped:-0}))" -eq 50 ]
}
check "the burst counts, the excess doesn't, and together they are all 50" rate_limit_splits_the_traffic

log "=== 11. Maintenance mode has no rows ==="
accepted_config "" "  maintenance_mode: true" | apply_config || die "reload with maintenance mode"
stats=$(stats_json)
check "route_accepted is an empty list" eval '[[ $stats == *"\"route_accepted\":[]"* ]]'
metrics=$(metrics_text)
check "the Prometheus metrics stay declared" eval '[[ $metrics == *"# TYPE evuproxy_route_accepted_packets_total counter"* ]]'
check "with no samples" eval '[[ $metrics != *"evuproxy_route_accepted_packets_total{"* ]]'
check "and the last Apply's rules are gone" eval '[[ $(in_ns proxy nft list table inet evuproxy_accepted 2>&1) != *evuproxy-accepted* ]]'

log "=== 12. A route with several ports keeps its row and counts ==="
# nft lists a conntrack port set as raw values, unlike a single port, so this needs the real thing.
PORT_SET_A=15410 PORT_SET_B=15412 PORT_SET_B_END=15413 MAP_SET_A=15420 MAP_SET_B=15422
R_SET=0 R_MAPPED_SET=1
apply_config <<EOF || die "reload with port sets"
forwarding:
  routes:
    - proto: tcp
      ports: ["$PORT_SET_A", "$PORT_SET_B-$PORT_SET_B_END"]
      target_ip: $PEER_TUNNEL_IP
    - proto: tcp
      ports: ["$MAP_SET_A", "$MAP_SET_B"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_SET_A", internal: "$PORT_SET_A"}, {public: "$MAP_SET_B", internal: "$PORT_SET_B"}]
input_allows: []
geo:
  enabled: false
EOF
serve_tcp peer "$PEER_TUNNEL_IP" "$PORT_SET_A"
serve_tcp peer "$PEER_TUNNEL_IP" "$PORT_SET_B"
check "a route with a set has a row" accepted_is "$R_SET" tcp 0
check "a mapped route with a set has a row" accepted_is "$R_MAPPED_SET" tcp 0
check "the first port passes" reaches "$TCP_OK" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT_SET_A"
check "and counts" accepted_at_least "$R_SET" tcp 3
sleep 0.5
set_count=$(accepted_packets "$R_SET" tcp)
check "the range passes" reaches "$TCP_OK" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT_SET_B"
check "and counts on top" accepted_at_least "$R_SET" tcp "$((set_count + 3))"
check "the mapped route stays at zero" accepted_is "$R_MAPPED_SET" tcp 0
check "a mapped port passes" reaches "$TCP_OK" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$MAP_SET_B"
check "and counts on its own route" accepted_at_least "$R_MAPPED_SET" tcp 3

log "=== 13. Rules that no longer fit the applied config have no row ==="
accepted_config | apply_config || die "reload"
check "both routes start with a row" eval '[ -n "$(accepted_row "$R_UDP" udp)" ] && [ -n "$(accepted_row "$R_SILENT" udp)" ]'
# What a failed Apply can leave: same target and protocol, but the applied config has them the
# other way around from the live rules.
sed -i "s/\"$PORT_UDP\"/\"swap\"/; s/\"$PORT_SILENT\"/\"$PORT_UDP\"/; s/\"swap\"/\"$PORT_SILENT\"/" /etc/evuproxy/config.yaml.bak
check "reordered routes have no row" eval '[ -z "$(accepted_row "$R_UDP" udp)" ] && [ -z "$(accepted_row "$R_SILENT" udp)" ]'
metrics=$(metrics_text)
check "or samples" eval '[[ $metrics != *"route_index=\"$R_UDP\""* && $metrics != *"route_index=\"$R_SILENT\""* ]]'
check "the others keep theirs" accepted_is "$R_TCP" tcp 0

kill "$serve_pid" 2>/dev/null
wait "$serve_pid" 2>/dev/null
