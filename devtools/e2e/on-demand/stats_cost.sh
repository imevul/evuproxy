#!/bin/bash
# What GET /stats and the nft and wg commands behind it cost as the geo set grows. Measures and
# reports, with no thresholds: each number is a RESULT line. See README.md.
# Sourced by inside.sh with a fresh topology.

SIZES=(0 1000 10000 50000 150000)
SAMPLES=7
IDLE_SECONDS=15
API=127.0.0.1:19848
ALL_CIDRS=/tmp/stats-cost-cidrs
TICK_MS=$((1000 / $(getconf CLK_TCK)))

apt-get install -y -qq --no-install-recommends time >/dev/null || die "apt-get install time"
log "cpu: $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2), $(nproc) cores"

# /24s with a gap between them, because auto-merge would fold neighbours into one interval.
printf '%s\n' {11..30}.{0..255}.{0..254..2}.0/24 >"$ALL_CIDRS"

# $1 elements, on top of the range the in-zone client needs.
write_zone() {
	{
		echo 203.0.113.0/24
		head -n "$1" "$ALL_CIDRS"
	} >"$ZONE_DIR/xa.zone"
}

apply_cost_config() {
	apply_config <<EOF
forwarding:
  routes:
    - proto: tcp
      ports: ["18080"]
      target_ip: $PEER_TUNNEL_IP
    - proto: udp
      ports: ["15353"]
      target_ip: $PEER_TUNNEL_IP
    - proto: both
      ports: ["15400"]
      target_ip: $PEER_TUNNEL_IP
input_allows: []
stats:
  drop_counters: true
geo:
  enabled: true
  mode: allow
  set_name: geo_v4
  countries: ["xa"]
  zone_dir: $ZONE_DIR
EOF
}

now_ms() {
	local t=${EPOCHREALTIME/./}
	echo $((t / 1000))
}
median() { sort -n | { mapfile -t v; echo "${v[$((${#v[@]} / 2))]}"; }; }
# Everything the server and the commands it has waited for have used, in ticks.
serve_ticks() {
	local stat
	read -r -a stat <"/proc/$serve_pid/stat"
	echo $((stat[13] + stat[14] + stat[15] + stat[16]))
}

stats_request() {
	printf 'GET /api/v1/stats HTTP/1.0\r\nAuthorization: Bearer e2e\r\n\r\n' |
		in_ns proxy socat -t120 -T120 - "TCP:$API" >/tmp/stats-cost.out
}
stats_ok() {
	head -n1 /tmp/stats-cost.out | grep -F ' 200 ' >/dev/null &&
		grep -F '"route_accepted":[{' /tmp/stats-cost.out >/dev/null
}

# $1 size. The whole request, with CPU as the server's own account of it.
measure_stats() {
	local size=$1 i start before after walls=()
	before=$(serve_ticks)
	for ((i = 0; i < SAMPLES; i++)); do
		start=$(now_ms)
		stats_request
		walls+=($(($(now_ms) - start)))
	done
	after=$(serve_ticks)
	log "RESULT | $size | GET /stats | $(printf '%s\n' "${walls[@]}" | median) ms | $(printf '%s\n' "${walls[@]}" | sort -n | tail -n1) ms | $(((after - before) * TICK_MS / SAMPLES)) ms cpu | - | $(wc -c </tmp/stats-cost.out) bytes |"
	check "GET /stats answers with the route rows at $size elements" stats_ok
}

# $1 size, $2 label, the rest the command. CPU and memory come from GNU time, inside the namespace.
measure_command() {
	local size=$1 label=$2 i start user sys rss cpu_cs=0 walls=()
	shift 2
	for ((i = 0; i < SAMPLES; i++)); do
		start=$(now_ms)
		in_ns proxy /usr/bin/time -f '%U %S %M' -o /tmp/stats-cost.time "$@" >/tmp/stats-cost.cmd 2>&1
		walls+=($(($(now_ms) - start)))
		read -r user sys rss </tmp/stats-cost.time
		cpu_cs=$((cpu_cs + 10#${user/./} + 10#${sys/./}))
	done
	log "RESULT | $size | $label | $(printf '%s\n' "${walls[@]}" | median) ms | $(printf '%s\n' "${walls[@]}" | sort -n | tail -n1) ms | $((cpu_cs * 10 / SAMPLES)) ms cpu | $((rss / 1024)) MiB rss | $(wc -c </tmp/stats-cost.cmd) bytes |"
}

# The set really holds what the row says: at least one comma per element in the listing.
set_holds() {
	local got
	got=$(in_ns proxy nft list set inet evuproxy geo_v4 | tr -cd , | wc -c)
	[ "$got" -ge "$1" ] || { log "  wanted $1 elements, listing has $got"; return 1; }
}
# Omitting the set contents must not change a single counter line.
terse_keeps_counters() {
	local family lines
	for family in inet ip; do
		lines=$(in_ns proxy nft -a list table "$family" evuproxy | grep -F counter)
		# The ip table only does NAT, so it has no counters to compare. The inet one must have some.
		[ "$family" = ip ] || [ -n "$lines" ] || { log "  no counter lines in $family"; return 1; }
		[ "$lines" = "$(in_ns proxy nft -a -t list table "$family" evuproxy | grep -F counter)" ] || { log "  -t changed the $family counter lines"; return 1; }
	done
}

write_zone 0
apply_cost_config || die "first apply"
# Not in_ns: a backgrounded function is a subshell, and kill would miss serve inside it.
ip netns exec proxy env EVUPROXY_API_TOKEN=e2e evuproxy --config /etc/evuproxy/config.yaml serve \
	--listen "$API" --token-file "" </dev/null >/tmp/serve-cost.log 2>&1 &
serve_pid=$!
wait_for_listener proxy -t "$API"

log "RESULT | elements | what | median | max | cpu per run | peak memory | output |"
for size in "${SIZES[@]}"; do
	write_zone "$size"
	start=$(now_ms)
	check "reload loads $size elements" proxy_reload
	log "RESULT | $size | evuproxy reload | $(($(now_ms) - start)) ms | - | - | - | - |"
	check "the set holds $size elements" set_holds "$size"
	check "-t keeps every counter line at $size elements" terse_keeps_counters

	idle_before=$(serve_ticks)
	sleep "$IDLE_SECONDS"
	log "RESULT | $size | serve idle, ${IDLE_SECONDS}s | - | - | $((($(serve_ticks) - idle_before) * TICK_MS)) ms cpu | - | - |"

	measure_stats "$size"
	measure_command "$size" "wg show dump" wg show "$PROXY_IFACE" dump
	measure_command "$size" "nft -a list table inet" nft -a list table inet evuproxy
	measure_command "$size" "nft -a list table ip" nft -a list table ip evuproxy
	measure_command "$size" "nft -a -t list table inet" nft -a -t list table inet evuproxy
	measure_command "$size" "nft -a -t list table ip" nft -a -t list table ip evuproxy
	measure_command "$size" "nft list chain route_accepted" nft list chain inet evuproxy route_accepted
	measure_command "$size" "nft -t list chain route_accepted" nft -t list chain inet evuproxy route_accepted
done

kill "$serve_pid" 2>/dev/null
wait "$serve_pid" 2>/dev/null
