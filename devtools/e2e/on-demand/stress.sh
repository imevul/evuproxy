#!/bin/bash
# Rate limits and CrowdSec drops under load, with legitimate traffic alongside. See README.md for
# what the thresholds mean. All load goes from wan to proxy to peer, inside this container.
# Sourced by inside.sh with a fresh topology.

TCP_PORT=18080
UDP_PORT=15353

# What the config asks for.
SYN_LIMIT=20
SYN_BURST=40 # rateLimitBurst(20)
UDP_LIMIT=100
UDP_BURST=100 # rateLimitBurst(100)
MAX_CONN=5

# The load. Flood rates are ten times the limit, and legitimate clients stay well under it.
SECONDS_OF_LOAD=6
SYN_FLOOD=200
UDP_FLOOD=1000
LEGIT_TCP=5
LEGIT_UDP=20
SWARM_SOURCES=20
SWARM_SYN_EACH=40

# The thresholds, in percent. A limit is a token bucket, so at most rate x time + burst can pass.
FLOOD_MAX_PCT=110  # of rate x time + burst
FLOOD_MIN_PCT=90   # of rate x time, so a limit that blocks everything fails too
LEGIT_MIN_PCT=95   # of a legitimate client's attempts, through any flood
BASELINE_MIN_PCT=99 # of the flood itself with no limits: the harness can carry this load
# Seconds of a run to skip after a ban or reload before asserting on it.
SETTLE_SECONDS=2
# Banned datagrams that may pass during a reload: 100ms of the flood. Measured at under 10.
RELOAD_GAP_MAX=$((UDP_FLOOD / 10))

ATTACKER=$CLIENT_OUT_OF_ZONE
LEGIT=$CLIENT_IN_ZONE
DST=$PROXY_PUBLIC_IP

config_with() {
	cat <<EOF
forwarding:
  routes:
    - proto: tcp
      ports: ["$TCP_PORT"]
      target_ip: $PEER_TUNNEL_IP
    - proto: udp
      ports: ["$UDP_PORT"]
      target_ip: $PEER_TUNNEL_IP
${1:-}
geo:
  enabled: false
  break_glass_cidrs: ["$BREAK_GLASS_IP/32"]
crowdsec:
  enabled: ${2:-false}
input_allows: []
EOF
}
RATE_LIMITS="  rate_limit:
    tcp_syn_per_second: $SYN_LIMIT
    udp_per_second: $UDP_LIMIT"
CONN_LIMIT="  rate_limit:
    max_conn_per_ip: $MAX_CONN"
BREAK_GLASS_IP=203.0.113.200

# Every number that is asserted also goes in the report as a RESULT line.
in_range() { [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]; }
measured() {
	local name=$1 got=$2 lo=$3 hi=$4
	log "RESULT | $name | $got | $lo..$hi |"
	check "$name: $got is in $lo..$hi" in_range "$got" "$lo" "$hi"
}
field() {
	local v=" $2"
	v=${v##* "$1"=}
	echo "${v%% *}"
}
pct() { echo $(($1 * $2 / 100)); }

load() { in_ns wan loadgen "$@" -dst "$LOAD_DST"; }
tcp_load() { LOAD_DST=$DST:$TCP_PORT load tcp -src "$1" -rate "$2" -seconds "${3:-$SECONDS_OF_LOAD}"; }
udp_load() { LOAD_DST=$DST:$UDP_PORT load udp -src "$1" -rate "$2" -seconds "${3:-$SECONDS_OF_LOAD}"; }
hold_tcp() { LOAD_DST=$DST:$TCP_PORT load hold -src "$1" -conns "$2" -seconds "$3"; }
hold_udp() { LOAD_DST=$DST:$UDP_PORT load holdudp -src "$1" -conns "$2"; }

# Limiter state idles out of its 2s sets, so runs don't inherit each other's tokens.
let_meters_expire() { sleep 3; }

# What a client should see: nearly every attempt answered.
legit_ok() {
	local name=$1 line=$2
	local sent
	sent=$(field sent "$line")
	measured "$name" "$(field ok "$line")" "$(pct "$sent" "$LEGIT_MIN_PCT")" "$sent"
}
flood_capped() {
	local name=$1 line=$2 rate=$3 burst=$4 sources=${5:-1}
	local most=$(((rate * SECONDS_OF_LOAD + burst) * sources))
	local least=$((rate * SECONDS_OF_LOAD * sources))
	measured "$name" "$(field ok "$line")" "$(pct "$least" "$FLOOD_MIN_PCT")" "$(pct "$most" "$FLOOD_MAX_PCT")"
}
# Sums per_sec for the seconds from $2 up to but not including $3.
ok_between() {
	local line=$1 from=$2 to=$3 total=0 i=0 n per_sec
	per_sec=$(field per_sec "$line")
	for n in ${per_sec//,/ }; do
		[ "$i" -lt "$from" ] || [ "$i" -ge "$to" ] || total=$((total + n))
		i=$((i + 1))
	done
	echo "$total"
}

# What the CrowdSec bouncer does on a decision. CrowdSec itself needs the Hub and the journal,
# so the scenario stands in for it at the point where it meets EvuProxy: the set.
ban() { in_ns proxy nft add element inet evuproxy crowdsec_block_v4 "{ $1 timeout $2 }"; }
unban() { in_ns proxy nft delete element inet evuproxy crowdsec_block_v4 "{ $1 }"; }

log "=== Setup ==="
config_with | apply_config || die "first reload"
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
in_ns peer loadgen serve -bind "$PEER_TUNNEL_IP" -tcp "$TCP_PORT" -udp "$UDP_PORT" </dev/null >/dev/null 2>&1 &
wait_for_listener peer -t "$PEER_TUNNEL_IP:$TCP_PORT"
in_ns wan ip addr add "$BREAK_GLASS_IP/32" dev lo
SWARM=""
for ((i = 1; i <= SWARM_SOURCES; i++)); do
	in_ns wan ip addr add "198.51.100.$((100 + i))/32" dev lo
	SWARM+="${SWARM:+,}198.51.100.$((100 + i))"
done

log "=== 1. Baseline: with no limits the harness carries the whole flood ==="
total=$((SYN_FLOOD * SECONDS_OF_LOAD))
measured "baseline: TCP $SYN_FLOOD/s answered" "$(field ok "$(tcp_load "$ATTACKER" "$SYN_FLOOD")")" "$(pct "$total" "$BASELINE_MIN_PCT")" "$total"
total=$((UDP_FLOOD * SECONDS_OF_LOAD))
measured "baseline: UDP $UDP_FLOOD/s answered" "$(field ok "$(udp_load "$ATTACKER" "$UDP_FLOOD")")" "$(pct "$total" "$BASELINE_MIN_PCT")" "$total"

log "=== 2. tcp_syn_per_second under a flood ==="
config_with "$RATE_LIMITS" | apply_config || die "reload with rate limits"
out=$(mktemp -d)
tcp_load "$ATTACKER" "$SYN_FLOOD" >"$out/flood" &
flood_pid=$!
tcp_load "$LEGIT" "$LEGIT_TCP" >"$out/legit" &
legit_pid=$!
wait "$flood_pid" "$legit_pid"
flood_capped "TCP flood $SYN_FLOOD/s, limit $SYN_LIMIT/s: answered" "$(<"$out/flood")" "$SYN_LIMIT" "$SYN_BURST"
legit_ok "TCP client $LEGIT_TCP/s beside that flood: answered" "$(<"$out/legit")"
let_meters_expire
legit_ok "TCP from the flood's source after it stops: answered" "$(tcp_load "$ATTACKER" "$LEGIT_TCP" 3)"
let_meters_expire
legit_ok "TCP from a client alone, under the limit: answered" "$(tcp_load "$LEGIT" "$((SYN_LIMIT / 2))")"
let_meters_expire

log "=== 3. udp_per_second under a flood, on one flow ==="
udp_load "$ATTACKER" "$UDP_FLOOD" >"$out/flood" &
flood_pid=$!
udp_load "$LEGIT" "$LEGIT_UDP" >"$out/legit" &
legit_pid=$!
wait "$flood_pid" "$legit_pid"
flood_capped "UDP flood $UDP_FLOOD/s, limit $UDP_LIMIT/s: answered" "$(<"$out/flood")" "$UDP_LIMIT" "$UDP_BURST"
legit_ok "UDP client $LEGIT_UDP/s beside that flood: answered" "$(<"$out/legit")"
let_meters_expire
legit_ok "UDP from the flood's source after it stops: answered" "$(udp_load "$ATTACKER" "$LEGIT_UDP" 3)"
let_meters_expire

log "=== 4. The limit is per source: $SWARM_SOURCES sources at once ==="
tcp_load "$SWARM" "$((SWARM_SOURCES * SWARM_SYN_EACH))" >"$out/flood" &
flood_pid=$!
tcp_load "$LEGIT" "$LEGIT_TCP" >"$out/legit" &
legit_pid=$!
wait "$flood_pid" "$legit_pid"
flood_capped "TCP swarm $SWARM_SOURCES x $SWARM_SYN_EACH/s: answered" "$(<"$out/flood")" "$SYN_LIMIT" "$SYN_BURST" "$SWARM_SOURCES"
legit_ok "TCP client beside the swarm: answered" "$(<"$out/legit")"
let_meters_expire

log "=== 5. Break-glass is exempt from rate limits ==="
total=$((SYN_FLOOD * SECONDS_OF_LOAD))
measured "break-glass source flooding TCP: answered" "$(field ok "$(tcp_load "$BREAK_GLASS_IP" "$SYN_FLOOD")")" "$(pct "$total" "$BASELINE_MIN_PCT")" "$total"

log "=== 6. max_conn_per_ip ==="
config_with "$CONN_LIMIT" | apply_config || die "reload with max conn"
# Longer than the 10 attempts can take, so the second source arrives while these are all held.
hold_tcp "$ATTACKER" "$((MAX_CONN * 2))" 8 >"$out/flood" &
flood_pid=$!
sleep 6
line=$(hold_tcp "$LEGIT" "$MAX_CONN" 1)
measured "second source opens $MAX_CONN while the first is at its limit" "$(field opened "$line")" "$MAX_CONN" "$MAX_CONN"
measured "those stay usable" "$(field alive "$line")" "$MAX_CONN" "$MAX_CONN"
wait "$flood_pid"
line=$(<"$out/flood")
measured "a source trying for $((MAX_CONN * 2)) connections gets" "$(field opened "$line")" "$MAX_CONN" "$MAX_CONN"
measured "and the ones it got stay usable" "$(field alive "$line")" "$MAX_CONN" "$MAX_CONN"
# The closes need a moment to reach conntrack. Not a sticky ban.
sleep 2
measured "after closing, the same source opens $MAX_CONN again" "$(field opened "$(hold_tcp "$ATTACKER" "$MAX_CONN" 0)")" "$MAX_CONN" "$MAX_CONN"
line=$(hold_udp "$LEGIT" "$((MAX_CONN * 2))")
measured "UDP: a source trying for $((MAX_CONN * 2)) flows gets" "$(field opened "$line")" "$MAX_CONN" "$MAX_CONN"
measured "and the ones it got stay usable" "$(field alive "$line")" "$MAX_CONN" "$MAX_CONN"

log "=== 7. A CrowdSec ban lands in the middle of a flood ==="
config_with "" true | apply_config || die "reload with crowdsec"
BAN_RUN=8
udp_load "$ATTACKER" "$UDP_FLOOD" "$BAN_RUN" >"$out/flood" &
flood_pid=$!
tcp_load "$LEGIT" "$LEGIT_TCP" "$BAN_RUN" >"$out/legit" &
legit_pid=$!
sleep 3
ban "$ATTACKER" 10m
wait "$flood_pid" "$legit_pid"
line=$(<"$out/flood")
per_sec_before=$(pct "$((UDP_FLOOD * 2))" "$BASELINE_MIN_PCT")
measured "UDP flood before the ban, first 2s: answered" "$(ok_between "$line" 0 2)" "$per_sec_before" "$((UDP_FLOOD * 2))"
measured "UDP flood from ${SETTLE_SECONDS}s after the ban: answered" "$(ok_between "$line" $((3 + SETTLE_SECONDS)) "$BAN_RUN")" 0 0
legit_ok "TCP client through the ban: answered" "$(<"$out/legit")"
measured "a new TCP connection from the banned source" "$(field ok "$(tcp_load "$ATTACKER" "$SYN_FLOOD" 2)")" 0 0

log "=== 8. A ban survives a reload under load ==="
udp_load "$ATTACKER" "$UDP_FLOOD" >"$out/flood" &
flood_pid=$!
udp_load "$LEGIT" "$LEGIT_UDP" >"$out/legit" &
legit_pid=$!
sleep 2
proxy_reload || die "reload under load"
wait "$flood_pid" "$legit_pid"
line=$(<"$out/flood")
# reload replaces the table, then puts the bans back, so a few datagrams pass in between.
measured "UDP flood from the banned source during the reload: answered" "$(ok_between "$line" 0 "$((2 + SETTLE_SECONDS))")" 0 "$RELOAD_GAP_MAX"
measured "UDP flood from ${SETTLE_SECONDS}s after the reload: answered" "$(ok_between "$line" "$((2 + SETTLE_SECONDS))" "$SECONDS_OF_LOAD")" 0 0
legit_ok "UDP client across that reload: answered" "$(<"$out/legit")"

log "=== 9. A ban ends when it is lifted or expires ==="
unban "$ATTACKER"
total=$((LEGIT_TCP * 3))
measured "after an unban: answered" "$(field ok "$(tcp_load "$ATTACKER" "$LEGIT_TCP" 3)")" "$(pct "$total" "$LEGIT_MIN_PCT")" "$total"
udp_load "$ATTACKER" "$UDP_FLOOD" "$BAN_RUN" >"$out/flood" &
flood_pid=$!
sleep 1
ban "$ATTACKER" 4s
wait "$flood_pid"
line=$(<"$out/flood")
measured "during a 4s ban, its middle 2s: answered" "$(ok_between "$line" 2 4)" 0 0
measured "once it expired, last 2s: answered" "$(ok_between "$line" 6 "$BAN_RUN")" "$per_sec_before" "$((UDP_FLOOD * 2))"

log "=== 10. A big ban list doesn't slow legitimate traffic ==="
{
	echo "add element inet evuproxy crowdsec_block_v4 {"
	for ((a = 0; a < 40; a++)); do
		for ((b = 0; b < 250; b++)); do
			echo "10.$((200 + a)).$b.1 timeout 10m,"
		done
	done
	echo "}"
} | in_ns proxy nft -f - || die "load the ban list"
measured "bans in the set" "$(in_ns proxy nft list set inet evuproxy crowdsec_block_v4 | grep -o 'expires' | wc -l)" 10000 10000
total=$((UDP_FLOOD * SECONDS_OF_LOAD))
measured "UDP $UDP_FLOOD/s past 10000 bans: answered" "$(field ok "$(udp_load "$LEGIT" "$UDP_FLOOD")")" "$(pct "$total" "$BASELINE_MIN_PCT")" "$total"
# Otherwise a failure's diagnostics print all of them.
in_ns proxy nft flush set inet evuproxy crowdsec_block_v4

check "the tunnel survived all of it" tunnel_pings
rm -rf "$out"
