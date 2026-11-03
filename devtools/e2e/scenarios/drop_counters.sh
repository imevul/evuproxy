#!/bin/bash
# stats.drop_counters: off renders no counters, and on counts real packets at each kind of drop.
# Sourced by inside.sh with a fresh topology.

PORT=15353
UNROUTED_TARGET=10.100.0.9
UNROUTED_PORT=15354
UDP_OK="udp-ok from=$PROXY_TUNNEL_IP"

# $1 is the other top-level sections, $2 optional extra lines under forwarding.
counters_config() {
	cat <<EOF
forwarding:
${2:-}
  routes:
    - proto: udp
      ports: ["$PORT"]
      target_ip: $PEER_TUNNEL_IP
input_allows: []
$1
EOF
}
COUNTERS_ON='stats:
  drop_counters: true'
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

# The same listing Stats parses. $1 is the family, $2 text that picks out one rule.
packets_of() {
	in_ns proxy nft -a list table "$1" evuproxy | grep -F "$2" | head -1 | grep -oE 'counter packets [0-9]+' | cut -d' ' -f3
}
count_is() {
	local got
	got=$(packets_of "$1" "$2")
	[ "$got" = "$3" ] || { log "  wanted $3 packets on '$2', got '$got'"; return 1; }
}
# Captured first: under pipefail, grep -q can kill nft with SIGPIPE, and ! would turn that into a
# pass. The count-only rules of route_accepted render whatever this setting says.
no_counters() {
	local rules
	rules=$(in_ns proxy nft list ruleset) || return 1
	rules=$(grep -v evuproxy-accepted <<<"$rules")
	[[ $rules != *counter* ]]
}
refuse_twice() {
	check "$2: first probe gets no answer" blocked udp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT"
	check "$2: second probe gets no answer" blocked udp_reply wan "$1" "$PROXY_PUBLIC_IP" "$PORT"
}

log "=== 1. Off by default ==="
counters_config "$GEO_OFF" | apply_config || die "reload"
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
serve_udp peer "$PEER_TUNNEL_IP" "$PORT"
check "the forward answers" reaches "$UDP_OK" udp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT"
check "no setting renders no counters" no_counters

counters_config "$(geo_on allow)" | apply_config || die "reload with geo allow, counters off"
refuse_twice "$CLIENT_OUT_OF_ZONE" "off, geo allow"
check "dropping traffic with the setting off still renders no counters" no_counters

log "=== 2. Geo allow counts on input ==="
counters_config "$COUNTERS_ON
$(geo_on allow)" | apply_config || die "reload with geo allow"
check "a listed client still passes" reaches "$UDP_OK" udp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT"
check "and is not counted" count_is inet 'ip saddr != @geo_v4 counter' 0
refuse_twice "$CLIENT_OUT_OF_ZONE" "geo allow"
check "the refused client's packets are counted" count_is inet 'ip saddr != @geo_v4 counter' 2

log "=== 3. Geo block counts in prerouting ==="
counters_config "$COUNTERS_ON
$(geo_on block)" | apply_config || die "reload with geo block"
check "another client still passes" reaches "$UDP_OK" udp_reply wan "$CLIENT_OUT_OF_ZONE" "$PROXY_PUBLIC_IP" "$PORT"
refuse_twice "$CLIENT_IN_ZONE" "geo block"
check "the refused client's packets are counted" count_is ip "ip saddr @geo_v4 udp dport $PORT counter" 2

log "=== 4. The global deny list counts in prerouting ==="
counters_config "$COUNTERS_ON
$GEO_OFF" "  source_deny_cidrs: [\"$CLIENT_IN_ZONE\"]" | apply_config || die "reload with deny"
check "another client still passes" reaches "$UDP_OK" udp_reply wan "$CLIENT_OUT_OF_ZONE" "$PROXY_PUBLIC_IP" "$PORT"
refuse_twice "$CLIENT_IN_ZONE" "deny"
check "the refused client's packets are counted" count_is ip "ip saddr @global_src_deny_v4 udp dport $PORT counter" 2

log "=== 5. CrowdSec counts on forward ==="
counters_config "$COUNTERS_ON
$GEO_OFF
crowdsec:
  enabled: true" | apply_config || die "reload with crowdsec"
in_ns proxy nft add element inet evuproxy crowdsec_block_v4 "{ $CLIENT_IN_ZONE }" || die "add ban"
check "another client still passes" reaches "$UDP_OK" udp_reply wan "$CLIENT_OUT_OF_ZONE" "$PROXY_PUBLIC_IP" "$PORT"
refuse_twice "$CLIENT_IN_ZONE" "crowdsec"
check "the banned client's packets are counted" count_is inet "oifname \"$PROXY_IFACE\" ip saddr @crowdsec_block_v4 udp dport $PORT counter" 2

log "=== 6. Rate limits count the excess ==="
counters_config "$COUNTERS_ON
$GEO_OFF" "  rate_limit:
    udp_per_second: 1" | apply_config || die "reload with rate limit"
in_ns wan bash -c "for i in {1..50}; do echo x >/dev/udp/$PROXY_PUBLIC_IP/$PORT; done" 2>/dev/null
# 50 datagrams at once, with a burst of 2. A slow runner earns a token or two along the way.
excess_counted() {
	local got
	got=$(packets_of inet "oifname \"$PROXY_IFACE\" udp dport $PORT update @ratelimit_udp_v4")
	log "  dropped $got of 50"
	[ "${got:-0}" -ge 40 ] && [ "$got" -le 48 ]
}
check "the excess is counted and the burst is not" excess_counted

log "=== 7. The forward catch-all counts past its log limit ==="
counters_config "$COUNTERS_ON
$GEO_OFF" | apply_config || die "reload for the catch-all"
in_ns wan ip route add "$UNROUTED_TARGET/32" via "$PROXY_PUBLIC_IP" || die "route to the unrouted target"
# Another port, because prerouting translates a route's port whatever the destination.
in_ns wan bash -c "for i in {1..50}; do echo x >/dev/udp/$UNROUTED_TARGET/$UNROUTED_PORT; done" 2>/dev/null
# Its log limit has a burst of 5, so a counter after the limit would stop near there.
check "all 50 are counted" count_is inet 'evuproxy-forward-drop' 50

log "=== 8. A reload starts the counts again ==="
proxy_reload || die "plain reload"
check "the catch-all is back at zero" count_is inet 'evuproxy-forward-drop' 0
