#!/bin/bash
# Real traffic against each forwarding policy: port maps, deny and allow lists, break-glass,
# route geo and maintenance mode. Sourced by inside.sh with a fresh topology.
#
# No answer can also mean a dead service or a broken forward, so every refusal sits next to a
# case that passes under the same config, on the same port or service.

# Two clients in each zone: one a policy names on its own, and one it doesn't.
CLIENT_XA=$CLIENT_IN_ZONE
CLIENT_XA_NAMED=203.0.113.20
CLIENT_XB=$CLIENT_OUT_OF_ZONE
CLIENT_XB_NAMED=198.51.100.20
in_ns wan ip addr add "$CLIENT_XA_NAMED/32" dev lo
in_ns wan ip addr add "$CLIENT_XB_NAMED/32" dev lo

# The peer listens on these, on the same port as the public one.
PORT_A=18080
PORT_B=18081
PORT_C=18082
PORT_UDP=15353
# Only the internal side of a port map has a listener, so an answer proves the translation.
MAP_PUBLIC=18300
MAP_INTERNAL=28300
MAP_LISTED_PUBLIC=18301
MAP_UDP_PUBLIC=15300
MAP_UDP_INTERNAL=25300
MAP_RANGE_PUBLIC=18400-18402
MAP_RANGE_INTERNAL=28400-28402
MAP_RANGE_FIRST_PUBLIC=18400
MAP_RANGE_LAST_PUBLIC=18402
MAP_RANGE_LAST_INTERNAL=28402
MAP_PARTIAL_PUBLIC=18500
MAP_PARTIAL_INTERNAL=28500
# On the proxy itself, for input_allows.
INPUT_PORT=19090
INPUT_CLOSED_PORT=19091

TCP_OK="tcp-ok from=$PROXY_TUNNEL_IP"
UDP_OK="udp-ok from=$PROXY_TUNNEL_IP"

# name, client, port. Every probe goes to the proxy's public address.
tcp_opens() { check "$1" reaches "$TCP_OK" tcp_reply wan "$2" "$PROXY_PUBLIC_IP" "$3"; }
tcp_refused() { check "$1" blocked tcp_reply wan "$2" "$PROXY_PUBLIC_IP" "$3"; }
udp_opens() { check "$1" reaches "$UDP_OK" udp_reply wan "$2" "$PROXY_PUBLIC_IP" "$3"; }
udp_refused() { check "$1" blocked udp_reply wan "$2" "$PROXY_PUBLIC_IP" "$3"; }

# $1 mode, $2 country, $3 any more lines for the geo section.
geo_on() {
	cat <<EOF
geo:
  enabled: true
  mode: $1
  set_name: geo_v4
  countries: ["$2"]
  zone_dir: $ZONE_DIR
${3:-}
EOF
}
GEO_OFF='geo:
  enabled: false'

log "=== Setup: the tunnel and the services behind it ==="
apply_config <<EOF || die "first reload"
forwarding:
  routes: []
$GEO_OFF
input_allows: []
EOF
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake

for port in "$PORT_A" "$PORT_B" "$PORT_C" "$MAP_INTERNAL" "$MAP_RANGE_LAST_INTERNAL" "$MAP_PARTIAL_INTERNAL"; do
	serve_tcp peer "$PEER_TUNNEL_IP" "$port"
done
serve_udp peer "$PEER_TUNNEL_IP" "$PORT_UDP"
serve_udp peer "$PEER_TUNNEL_IP" "$MAP_UDP_INTERNAL"
serve_tcp proxy "$PROXY_PUBLIC_IP" "$INPUT_PORT"
serve_tcp proxy "$PROXY_PUBLIC_IP" "$INPUT_CLOSED_PORT"

log "=== 1. Port maps ==="
apply_config <<EOF || die "reload with port maps"
forwarding:
  routes:
    - proto: tcp
      ports: ["$MAP_PUBLIC"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_PUBLIC", internal: "$MAP_INTERNAL"}]
    - proto: udp
      ports: ["$MAP_UDP_PUBLIC"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_UDP_PUBLIC", internal: "$MAP_UDP_INTERNAL"}]
    - proto: tcp
      ports: ["$MAP_RANGE_PUBLIC"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_RANGE_PUBLIC", internal: "$MAP_RANGE_INTERNAL"}]
    - proto: tcp
      ports: ["$MAP_PARTIAL_PUBLIC", "$PORT_A"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_PARTIAL_PUBLIC", internal: "$MAP_PARTIAL_INTERNAL"}]
$GEO_OFF
input_allows: []
EOF
tcp_opens "TCP public port reaches the internal port" "$CLIENT_XA" "$MAP_PUBLIC"
udp_opens "UDP public port reaches the internal port" "$CLIENT_XA" "$MAP_UDP_PUBLIC"
tcp_opens "a mapped range keeps its offset" "$CLIENT_XA" "$MAP_RANGE_LAST_PUBLIC"
tcp_refused "the range's first port doesn't land on the last internal port" "$CLIENT_XA" "$MAP_RANGE_FIRST_PUBLIC"
tcp_opens "the mapped port of a partly mapped route" "$CLIENT_XA" "$MAP_PARTIAL_PUBLIC"
tcp_opens "the unmapped port of a partly mapped route stays 1:1" "$CLIENT_XA" "$PORT_A"
tcp_refused "the internal TCP port isn't public" "$CLIENT_XA" "$MAP_INTERNAL"
udp_refused "the internal UDP port isn't public" "$CLIENT_XA" "$MAP_UDP_INTERNAL"
tcp_refused "a listening port with no route isn't public" "$CLIENT_XA" "$PORT_B"
# Sent straight at the peer, so prerouting has nothing to translate. Only the forward chain decides.
in_ns wan ip route add "$PEER_TUNNEL_IP/32" via "$PROXY_PUBLIC_IP" || die "route to the peer"
check "the internal port can't be reached by routing at the peer" blocked tcp_reply wan "$CLIENT_XA" "$PEER_TUNNEL_IP" "$MAP_INTERNAL"
in_ns wan ip route del "$PEER_TUNNEL_IP/32" via "$PROXY_PUBLIC_IP" || die "remove route to the peer"

apply_config <<EOF || die "reload with a mapped, listed route"
forwarding:
  routes:
    - proto: tcp
      ports: ["$MAP_LISTED_PUBLIC"]
      target_ip: $PEER_TUNNEL_IP
      port_maps: [{public: "$MAP_LISTED_PUBLIC", internal: "$MAP_INTERNAL"}]
      source_allow_cidrs: ["203.0.113.0/24"]
      source_deny_cidrs: ["$CLIENT_XA_NAMED"]
$GEO_OFF
input_allows: []
EOF
tcp_opens "mapped route with lists: a listed client passes" "$CLIENT_XA" "$MAP_LISTED_PUBLIC"
tcp_refused "mapped route with lists: an unlisted client is refused" "$CLIENT_XB" "$MAP_LISTED_PUBLIC"
tcp_refused "mapped route with lists: a denied client is refused" "$CLIENT_XA_NAMED" "$MAP_LISTED_PUBLIC"

log "=== 2. Deny and allow lists ==="
apply_config <<EOF || die "reload with route lists"
forwarding:
  routes:
    - proto: both
      ports: ["$PORT_A", "$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
      source_allow_cidrs: ["203.0.113.0/24"]
      source_deny_cidrs: ["$CLIENT_XA_NAMED"]
    - proto: tcp
      ports: ["$PORT_B"]
      target_ip: $PEER_TUNNEL_IP
$GEO_OFF
input_allows: []
EOF
tcp_opens "route allow: a listed client passes on TCP" "$CLIENT_XA" "$PORT_A"
udp_opens "route allow: a listed client passes on UDP" "$CLIENT_XA" "$PORT_UDP"
tcp_refused "route allow: an unlisted client is refused on TCP" "$CLIENT_XB" "$PORT_A"
udp_refused "route allow: an unlisted client is refused on UDP" "$CLIENT_XB" "$PORT_UDP"
tcp_refused "route deny beats route allow on TCP" "$CLIENT_XA_NAMED" "$PORT_A"
udp_refused "route deny beats route allow on UDP" "$CLIENT_XA_NAMED" "$PORT_UDP"
tcp_opens "route lists don't touch another route: unlisted client" "$CLIENT_XB" "$PORT_B"
tcp_opens "route lists don't touch another route: denied client" "$CLIENT_XA_NAMED" "$PORT_B"

global_deny_config() {
	cat <<EOF
forwarding:
  source_deny_cidrs: [$1]
  routes:
    - proto: both
      ports: ["$PORT_A", "$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
    - proto: tcp
      ports: ["$PORT_B"]
      target_ip: $PEER_TUNNEL_IP
      source_allow_cidrs: ["$CLIENT_XB_NAMED"]
$GEO_OFF
input_allows: []
EOF
}
global_deny_config "\"$CLIENT_XB_NAMED\"" | apply_config || die "reload with global deny"
tcp_opens "global deny: another client passes on TCP" "$CLIENT_XB" "$PORT_A"
udp_opens "global deny: another client passes on UDP" "$CLIENT_XB" "$PORT_UDP"
tcp_refused "global deny: the client is refused on TCP" "$CLIENT_XB_NAMED" "$PORT_A"
udp_refused "global deny: the client is refused on UDP" "$CLIENT_XB_NAMED" "$PORT_UDP"
tcp_refused "global deny beats a route's allow list" "$CLIENT_XB_NAMED" "$PORT_B"
global_deny_config "" | apply_config || die "reload with no global deny"
tcp_opens "lifting the deny lets the client back on TCP" "$CLIENT_XB_NAMED" "$PORT_A"
udp_opens "lifting the deny lets the client back on UDP" "$CLIENT_XB_NAMED" "$PORT_UDP"
tcp_opens "lifting the deny leaves the allow list working: listed" "$CLIENT_XB_NAMED" "$PORT_B"
tcp_refused "lifting the deny leaves the allow list working: unlisted" "$CLIENT_XB" "$PORT_B"

log "=== 3. Break-glass ==="
break_glass_config() {
	cat <<EOF
forwarding:
  routes:
    - proto: both
      ports: ["$PORT_A", "$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
$(geo_on "$1" xa "  break_glass_cidrs: [\"$2\"]")
input_allows: []
EOF
}
break_glass_config allow "$CLIENT_XB_NAMED" | apply_config || die "reload with geo allow and break-glass"
tcp_opens "geo allow: a listed country passes" "$CLIENT_XA" "$PORT_A"
tcp_refused "geo allow: another country is refused on TCP" "$CLIENT_XB" "$PORT_A"
udp_refused "geo allow: another country is refused on UDP" "$CLIENT_XB" "$PORT_UDP"
tcp_opens "geo allow: break-glass from that country passes on TCP" "$CLIENT_XB_NAMED" "$PORT_A"
udp_opens "geo allow: break-glass from that country passes on UDP" "$CLIENT_XB_NAMED" "$PORT_UDP"

break_glass_config block "$CLIENT_XA_NAMED" | apply_config || die "reload with geo block and break-glass"
tcp_opens "geo block: another country passes" "$CLIENT_XB" "$PORT_A"
tcp_refused "geo block: a listed country is refused on TCP" "$CLIENT_XA" "$PORT_A"
udp_refused "geo block: a listed country is refused on UDP" "$CLIENT_XA" "$PORT_UDP"
tcp_opens "geo block: break-glass from that country passes on TCP" "$CLIENT_XA_NAMED" "$PORT_A"
udp_opens "geo block: break-glass from that country passes on UDP" "$CLIENT_XA_NAMED" "$PORT_UDP"

# Break-glass only skips geo. It isn't a way past a list that names the route's clients.
apply_config <<EOF || die "reload with break-glass and lists"
forwarding:
  source_deny_cidrs: ["$CLIENT_XB"]
  routes:
    - proto: tcp
      ports: ["$PORT_A"]
      target_ip: $PEER_TUNNEL_IP
    - proto: tcp
      ports: ["$PORT_B"]
      target_ip: $PEER_TUNNEL_IP
      source_allow_cidrs: ["$CLIENT_XA"]
$(geo_on allow xa "  break_glass_cidrs: [\"198.51.100.0/24\"]")
input_allows: []
EOF
tcp_opens "break-glass client passes where no list applies" "$CLIENT_XB_NAMED" "$PORT_A"
tcp_refused "global deny beats break-glass" "$CLIENT_XB" "$PORT_A"
tcp_opens "a client on the route's allow list passes" "$CLIENT_XA" "$PORT_B"
tcp_refused "a route's allow list beats break-glass" "$CLIENT_XB_NAMED" "$PORT_B"

# The escape hatch an operator reaches for: their own way in, with geo on input_allows too.
apply_config <<EOF || die "reload with break-glass on input_allows"
forwarding:
  routes: []
$(geo_on allow xa "  apply_to_input_allows: true
  break_glass_cidrs: [\"$CLIENT_XB_NAMED\"]")
input_allows:
  - proto: tcp
    dport: "$INPUT_PORT"
EOF
input_reply() { reaches "tcp-ok from=$2" tcp_reply wan "$2" "$PROXY_PUBLIC_IP" "$1"; }
check "geo on input_allows: a listed country reaches the proxy" input_reply "$INPUT_PORT" "$CLIENT_XA"
check "geo on input_allows: another country is refused" blocked tcp_reply wan "$CLIENT_XB" "$PROXY_PUBLIC_IP" "$INPUT_PORT"
check "geo on input_allows: break-glass reaches the proxy" input_reply "$INPUT_PORT" "$CLIENT_XB_NAMED"

apply_config <<EOF || die "reload with geo block on input_allows"
forwarding:
  routes: []
$(geo_on block xa "  apply_to_input_allows: true
  break_glass_cidrs: [\"$CLIENT_XA_NAMED\"]")
input_allows:
  - proto: tcp
    dport: "$INPUT_PORT"
EOF
# More packets than the log limit's burst, because logging must not decide what gets dropped.
stays_blocked_past_log_limit() {
	local answers=/tmp/e2e-burst-answers i probes=()
	: >"$answers"
	for ((i = 0; i < 40; i++)); do
		tcp_reply wan "$1" "$PROXY_PUBLIC_IP" "$INPUT_PORT" >>"$answers" &
		probes+=($!)
	done
	# Only these: a plain wait would also wait for the services, which never exit.
	wait "${probes[@]}"
	[ ! -s "$answers" ] || { log "  got $(wc -l <"$answers") answers from $1"; return 1; }
}
check "geo block on input_allows: another country passes" input_reply "$INPUT_PORT" "$CLIENT_XB"
check "geo block on input_allows: break-glass passes" input_reply "$INPUT_PORT" "$CLIENT_XA_NAMED"
check "geo block on input_allows: a listed country is refused" blocked tcp_reply wan "$CLIENT_XA" "$PROXY_PUBLIC_IP" "$INPUT_PORT"
check "geo block on input_allows: still refused past the log limit" stays_blocked_past_log_limit "$CLIENT_XA"

log "=== 4. Route geo ==="
route_geo_config() {
	cat <<EOF
forwarding:
  routes:
    - proto: both
      ports: ["$PORT_A", "$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
    - proto: tcp
      ports: ["$PORT_B"]
      target_ip: $PEER_TUNNEL_IP
      geo_mode: "off"
    - proto: tcp
      ports: ["$PORT_C"]
      target_ip: $PEER_TUNNEL_IP
      geo_mode: custom
      geo_countries: ["xb"]
$1
input_allows: []
EOF
}
route_geo_config "$(geo_on allow xa)" | apply_config || die "reload with route geo, allow"
tcp_opens "allow, inherit: the global country passes on TCP" "$CLIENT_XA" "$PORT_A"
udp_opens "allow, inherit: the global country passes on UDP" "$CLIENT_XA" "$PORT_UDP"
tcp_refused "allow, inherit: another country is refused on TCP" "$CLIENT_XB" "$PORT_A"
udp_refused "allow, inherit: another country is refused on UDP" "$CLIENT_XB" "$PORT_UDP"
tcp_opens "allow, off: the global country passes" "$CLIENT_XA" "$PORT_B"
tcp_opens "allow, off: another country passes" "$CLIENT_XB" "$PORT_B"
tcp_opens "allow, custom: the route's country passes" "$CLIENT_XB" "$PORT_C"
tcp_refused "allow, custom: the global country is refused" "$CLIENT_XA" "$PORT_C"

route_geo_config "$(geo_on block xa)" | apply_config || die "reload with route geo, block"
tcp_refused "block, inherit: the global country is refused" "$CLIENT_XA" "$PORT_A"
tcp_opens "block, inherit: another country passes" "$CLIENT_XB" "$PORT_A"
tcp_opens "block, off: the global country passes" "$CLIENT_XA" "$PORT_B"
tcp_opens "block, off: another country passes" "$CLIENT_XB" "$PORT_B"
tcp_refused "block, custom: the route's country is refused" "$CLIENT_XB" "$PORT_C"
tcp_opens "block, custom: the global country passes" "$CLIENT_XA" "$PORT_C"

log "=== 5. Maintenance mode ==="
maintenance_config() {
	cat <<EOF
forwarding:
  maintenance_mode: $1
  routes:
    - proto: tcp
      ports: ["$PORT_A"]
      target_ip: $PEER_TUNNEL_IP
    - proto: udp
      ports: ["$PORT_UDP"]
      target_ip: $PEER_TUNNEL_IP
$GEO_OFF
input_allows:
  - proto: tcp
    dport: "$INPUT_PORT"
EOF
}
input_answers() { reaches "tcp-ok from=$CLIENT_XA" tcp_reply wan "$CLIENT_XA" "$PROXY_PUBLIC_IP" "$INPUT_PORT"; }

maintenance_config false | apply_config || die "reload before maintenance"
tcp_opens "before maintenance: the TCP forward passes" "$CLIENT_XA" "$PORT_A"
udp_opens "before maintenance: the UDP forward passes" "$CLIENT_XA" "$PORT_UDP"

maintenance_config true | apply_config || die "reload into maintenance"
tcp_refused "maintenance: the TCP forward is refused" "$CLIENT_XA" "$PORT_A"
udp_refused "maintenance: the UDP forward is refused" "$CLIENT_XA" "$PORT_UDP"
check "maintenance: the peer's TCP service is still up" reaches "$TCP_OK" tcp_reply proxy "$PROXY_TUNNEL_IP" "$PEER_TUNNEL_IP" "$PORT_A"
check "maintenance: the peer's UDP service is still up" reaches "$UDP_OK" udp_reply proxy "$PROXY_TUNNEL_IP" "$PEER_TUNNEL_IP" "$PORT_UDP"
check "maintenance: the tunnel stays up" tunnel_pings
check "maintenance: input_allows still answers" input_answers
check "maintenance: other proxy ports stay closed" blocked tcp_reply wan "$CLIENT_XA" "$PROXY_PUBLIC_IP" "$INPUT_CLOSED_PORT"

maintenance_config false | apply_config || die "reload out of maintenance"
tcp_opens "after maintenance: the TCP forward passes again" "$CLIENT_XA" "$PORT_A"
udp_opens "after maintenance: the UDP forward passes again" "$CLIENT_XA" "$PORT_UDP"
