#!/bin/bash
# Auto-pause against real handshakes: an idle healthy peer never pauses, a peer that goes away
# pauses, and one that comes back resumes. About 11 minutes, because handshakes take 180 seconds
# to go stale. Sourced by inside.sh with a fresh topology.

PORT=15355
EVENTS=/etc/evuproxy/state/events.jsonl
# Longer than the 180-second threshold and WireGuard's 120-second rekey, so an idle peer has to
# get through at least one full handshake cycle.
IDLE_SECONDS=200

# $1 is optional extra lines under auto_pause.
pause_config() {
	cat <<EOF
forwarding:
  routes:
    - name: game
      proto: udp
      ports: ["$PORT"]
      target_ip: $PEER_TUNNEL_IP
      pause_when_peer_offline: true
input_allows: []
geo:
  enabled: false
auto_pause:
  interval: 5s
${1:-}
EOF
}

event_count() { grep -c "\"event\":\"$1\"" "$EVENTS" 2>/dev/null; }
event_count_is() {
	local got
	got=$(event_count "$1")
	[ "${got:-0}" -eq "$2" ] || { log "  wanted $2 of $1, got '${got:-0}'"; return 1; }
}
# $1 event, $2 how many there should be, $3 how long to wait in seconds.
wait_for_event() {
	local i
	for ((i = 0; i < $3; i++)); do
		[ "$(event_count "$1")" -ge "$2" ] 2>/dev/null && { log "  $1 after ${i}s"; return 0; }
		sleep 1
	done
	log "  no $1 within $3s"
	return 1
}
start_serve() {
	# Not in_ns: a backgrounded function is a subshell, and kill would miss serve inside it.
	ip netns exec proxy env EVUPROXY_API_TOKEN=e2e evuproxy --config /etc/evuproxy/config.yaml serve \
		--listen 127.0.0.1:19847 --token-file "" </dev/null >>/tmp/serve.log 2>&1 &
	serve_pid=$!
}
stop_serve() {
	kill "$serve_pid" 2>/dev/null
	wait "$serve_pid" 2>/dev/null
}
peer_down() { in_ns peer ip link del "$PEER_IFACE"; }
stale_handshake() {
	local last now
	last=$(in_ns proxy wg show "$PROXY_IFACE" latest-handshakes | cut -f2)
	now=$(date +%s)
	log "  handshake age $((now - last))s"
	[ $((now - last)) -gt 180 ]
}
config_has_no_disabled() { ! grep -q 'disabled' /etc/evuproxy/config.yaml; }

log "=== 1. An idle, healthy peer stays up ==="
pause_config | apply_config || die "reload"
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
start_serve
sleep "$IDLE_SECONDS"
check "no traffic for ${IDLE_SECONDS}s doesn't pause the route" event_count_is route_auto_paused 0

log "=== 2. A peer that goes away pauses ==="
before=$(sha256sum /etc/evuproxy/config.yaml)
peer_down || die "peer down"
check "the route pauses once the handshake is stale" wait_for_event route_auto_paused 1 240
check "the handshake really was stale" stale_handshake
check "the event names the route and peer" grep -q 'game: udp 15355 .*(peer peer offline)' "$EVENTS"

log "=== 3. Pause state stays out of config ==="
check "config.yaml is untouched" test "$before" = "$(sha256sum /etc/evuproxy/config.yaml)"
check "nothing wrote disabled" config_has_no_disabled

log "=== 4. A restart starts as up, and re-trips ==="
stop_serve
start_serve
check "still offline, so it pauses again after the threshold" wait_for_event route_auto_paused 2 30

log "=== 5. A peer that comes back resumes ==="
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh again"
check "the route resumes" wait_for_event route_auto_resumed 1 60
check "and stays that way for a while" sleep 20
check "no extra pause" event_count_is route_auto_paused 2

log "=== 6. With the ICMP fallback, a peer that doesn't answer still pauses ==="
stop_serve
pause_config '  icmp_fallback: true' | apply_config || die "reload with fallback"
peer_down || die "peer down again"
start_serve
check "no ping reply counts as a failure" wait_for_event route_auto_paused 3 260

log "--- serve log ---"
cat /tmp/serve.log
stop_serve
