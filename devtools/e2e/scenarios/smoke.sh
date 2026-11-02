#!/bin/bash
# Tunnel, TCP and UDP forwards, geo on and off, and a peer with narrow AllowedIPs on a LAN.
# Sourced by inside.sh with a fresh topology.

TCP_PORT=18080
UDP_PORT=15353
UNROUTED_PORT=18081

no_routes() {
	cat <<EOF
forwarding:
  routes: []
geo:
  enabled: false
input_allows: []
EOF
}
# $1 is the geo section. A route inherits it unless it says otherwise.
with_routes() {
	cat <<EOF
forwarding:
  routes:
    - proto: tcp
      ports: ["$TCP_PORT"]
      target_ip: $PEER_TUNNEL_IP
    - proto: udp
      ports: ["$UDP_PORT"]
      target_ip: $PEER_TUNNEL_IP
input_allows: []
$1
EOF
}
GEO_OFF='geo:
  enabled: false'
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

# Whatever passes reports the proxy's tunnel address: the peer must see the masqueraded
# source, or its replies would leave by its default route instead of the tunnel.
TCP_OK="tcp-ok from=$PROXY_TUNNEL_IP"
UDP_OK="udp-ok from=$PROXY_TUNNEL_IP"
forward_open() {
	local client=$1
	check "$2: TCP forward answers" reaches "$TCP_OK" tcp_reply wan "$client" "$PROXY_PUBLIC_IP" "$TCP_PORT"
	check "$2: UDP forward answers" reaches "$UDP_OK" udp_reply wan "$client" "$PROXY_PUBLIC_IP" "$UDP_PORT"
}
forward_closed() {
	local client=$1
	check "$2: TCP forward gets no answer" blocked tcp_reply wan "$client" "$PROXY_PUBLIC_IP" "$TCP_PORT"
	check "$2: UDP forward gets no answer" blocked udp_reply wan "$client" "$PROXY_PUBLIC_IP" "$UDP_PORT"
}

log "=== 1. The tunnel comes up ==="
no_routes | apply_config || die "first reload"
check "reload created the interface" in_ns proxy test -e "/sys/class/net/$PROXY_IFACE"
check "the interface has the tunnel address" bash -c "ip netns exec proxy ip -4 -o addr show dev $PROXY_IFACE | grep -q ' $PROXY_TUNNEL_IP/24 '"
check "the firewall is live, default drop" bash -c "ip netns exec proxy nft list chain inet evuproxy input | grep -q 'policy drop'"
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
check "the proxy pings the peer through the tunnel" tunnel_pings

# Only on the tunnel address, so a forward can't reach them any other way.
serve_tcp peer "$PEER_TUNNEL_IP" "$TCP_PORT"
serve_udp peer "$PEER_TUNNEL_IP" "$UDP_PORT"
serve_tcp peer "$PEER_TUNNEL_IP" "$UNROUTED_PORT"
check "the proxy reaches the peer's TCP service through the tunnel" reaches "tcp-ok from=$PROXY_TUNNEL_IP" tcp_reply proxy "$PROXY_TUNNEL_IP" "$PEER_TUNNEL_IP" "$TCP_PORT"
check "the proxy reaches the peer's UDP service through the tunnel" reaches "udp-ok from=$PROXY_TUNNEL_IP" udp_reply proxy "$PROXY_TUNNEL_IP" "$PEER_TUNNEL_IP" "$UDP_PORT"

log "=== 2. TCP and UDP forwards ==="
forward_closed "$CLIENT_IN_ZONE" "no routes yet"
with_routes "$GEO_OFF" | apply_config || die "reload with routes"
forward_open "$CLIENT_IN_ZONE" "with routes"
check "a port with no route gets no answer" blocked tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$UNROUTED_PORT"
check "the tunnel survives a second reload" tunnel_pings

log "=== 3. Geo on and off ==="
forward_open "$CLIENT_OUT_OF_ZONE" "geo off, any client"
with_routes "$(geo_on allow)" | apply_config || die "reload with geo allow"
check "the zone reached the set in the filter table" bash -c "ip netns exec proxy nft list set inet evuproxy geo_v4 | grep -q 203.0.113.0/24"
check "and in the NAT table" bash -c "ip netns exec proxy nft list set ip evuproxy geo_v4 | grep -q 203.0.113.0/24"
forward_open "$CLIENT_IN_ZONE" "geo allow, listed client"
forward_closed "$CLIENT_OUT_OF_ZONE" "geo allow, other client"
check "geo allow leaves the tunnel up" tunnel_pings

with_routes "$(geo_on block)" | apply_config || die "reload with geo block"
forward_closed "$CLIENT_IN_ZONE" "geo block, listed client"
forward_open "$CLIENT_OUT_OF_ZONE" "geo block, other client"
check "geo block leaves the tunnel up" tunnel_pings

with_routes "$GEO_OFF" | apply_config || die "reload with geo off again"
check "the geo set is gone" bash -c "! ip netns exec proxy nft list set inet evuproxy geo_v4 >/dev/null 2>&1"
forward_open "$CLIENT_IN_ZONE" "geo off again, first client"
forward_open "$CLIENT_OUT_OF_ZONE" "geo off again, second client"

log "=== 4. A peer with narrow AllowedIPs still reaches the LAN ==="
serve_tcp lan "$LAN_HOST_IP" 18090
serve_udp lan "$LAN_HOST_IP" 15390
serve_tcp peer "$PEER_LAN_IP" 18091

allowed_ips_are_narrow() { [ "$(in_ns peer wg show "$PEER_IFACE" allowed-ips | cut -f2)" = "$TUNNEL_SUBNET" ]; }
lan_route_is_direct() { in_ns peer ip route get "$LAN_HOST_IP" | grep -q ' dev lan0 '; }
default_route_is_lan() { in_ns peer ip route get 198.18.0.1 | grep -q ' dev lan0 '; }
tunnel_route_is_tunnel() { in_ns peer ip route get "$PROXY_TUNNEL_IP" | grep -q " dev $PEER_IFACE "; }
check "the peer's AllowedIPs is only the tunnel subnet" allowed_ips_are_narrow
check "the LAN is routed directly" lan_route_is_direct
check "the default route still leaves by the LAN" default_route_is_lan
check "only the tunnel subnet goes through the tunnel" tunnel_route_is_tunnel

before=$(wg_bytes peer "$PEER_IFACE")
check "the peer reaches a LAN host over TCP" reaches "tcp-ok from=$PEER_LAN_IP" tcp_reply peer "$PEER_LAN_IP" "$LAN_HOST_IP" 18090
check "the peer reaches a LAN host over UDP" reaches "udp-ok from=$PEER_LAN_IP" udp_reply peer "$PEER_LAN_IP" "$LAN_HOST_IP" 15390
check "a LAN host reaches the peer" reaches "tcp-ok from=$LAN_HOST_IP" tcp_reply lan "$LAN_HOST_IP" "$PEER_LAN_IP" 18091
after=$(wg_bytes peer "$PEER_IFACE")
# Leaves room for a keepalive landing in the window, but not for the probes themselves.
lan_stayed_off_tunnel() { log "  tunnel bytes during the LAN probes: $((after - before))"; [ $((after - before)) -lt 200 ]; }
check "LAN traffic stayed off the tunnel" lan_stayed_off_tunnel
check "the proxy can't reach the LAN through the tunnel" blocked tcp_reply proxy "$PROXY_TUNNEL_IP" "$LAN_HOST_IP" 18090
forward_open "$CLIENT_IN_ZONE" "with the LAN in use"
