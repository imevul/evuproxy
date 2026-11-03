#!/bin/bash
# Library for the scenarios: the guard, the network and the helpers. See README.md for the
# topology. Only addresses from documentation ranges are used, and no namespace has a route
# out of the container, so geo zones can't be downloaded and probes can't leave by accident.

# Addresses a scenario needs. WAN clients live on one namespace and pick a source address.
# shellcheck disable=SC2034 # scenarios use these
PROXY_PUBLIC_IP=192.0.2.1
CLIENT_IN_ZONE=203.0.113.10      # in the xa zone, see write_geo_zones
CLIENT_OUT_OF_ZONE=198.51.100.10 # in the xb zone
PROXY_TUNNEL_IP=10.100.0.1
PEER_TUNNEL_IP=10.100.0.2
TUNNEL_SUBNET=10.100.0.0/24
PEER_LAN_IP=192.168.50.10
LAN_HOST_IP=192.168.50.20
WG_PORT=51830
PROXY_IFACE=evuproxy0
PEER_IFACE=evuproxy
ZONE_DIR=/etc/evuproxy/geo-zones

NAMESPACES=(wan proxy lan peer)

failures=0
checks=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
check() {
	local name=$1
	shift
	checks=$((checks + 1))
	if "$@"; then
		log "PASS: $name"
	else
		log "FAIL: $name"
		failures=$((failures + 1))
	fi
}
die() {
	log "SETUP FAILED: $*"
	exit 100
}
# Prints a refusal and stops. Runs before any namespace or scenario exists.
refuse() {
	echo "e2e: REFUSING TO RUN: $*" >&2
	exit 100
}

refuse_unless_disposable() {
	[ "${EVUPROXY_E2E_DISPOSABLE:-}" = 1 ] || refuse "start this with devtools/e2e/run.sh"
	[ -f /.dockerenv ] || refuse "not inside a Docker container"
	[ ! -e /etc/evuproxy/config.yaml ] || refuse "/etc/evuproxy/config.yaml exists, so this is an EvuProxy host"
	local dev
	for dev in /sys/class/net/*; do
		# A container on its own network only has virtual links. A physical one means --network host.
		[ ! -e "$dev/device" ] || refuse "$(basename "$dev") is a physical interface, so this shares a real network"
		[ ! -e "$dev/wireguard" ] || refuse "$(basename "$dev") is a WireGuard interface"
	done
}

install_tools() {
	log "installing tools"
	export DEBIAN_FRONTEND=noninteractive
	apt-get update -qq >/dev/null || die "apt-get update"
	apt-get install -y -qq --no-install-recommends \
		iproute2 iputils-ping nftables procps socat wireguard-tools >/dev/null || die "apt-get install"
	install -m 0755 /e2e-bin/evuproxy /e2e-bin/loadgen /usr/local/bin/ || die "install binaries"
	# The container mounts /proc/sys read-only. Only its net subtree needs writing, and that
	# is per-namespace, so the host's sysctls stay out of reach.
	mount --bind /proc/sys/net /proc/sys/net || die "bind /proc/sys/net"
	mount -o remount,rw,bind /proc/sys/net || die "writable /proc/sys/net"
	[ -z "$(nft list ruleset)" ] || refuse "this namespace already has firewall rules"
	RUNNER_NETNS=$(readlink /proc/self/ns/net)
	log "kernel $(uname -r), $(nft --version), $(wg --version | cut -d' ' -f1-2)"
}

in_ns() {
	local ns=$1
	shift
	ip netns exec "$ns" "$@"
}
ns_sysctl() { in_ns "$1" sh -c "echo $3 >/proc/sys/net/ipv4/$2"; }

# wan ---- proxy (runs evuproxy), and wan ---- lan (NAT router and a LAN host) ---- peer.
# The peer reaches the proxy's public address through the LAN router, like a server at home.
topology_up() {
	local ns
	for ns in "${NAMESPACES[@]}"; do
		ip netns add "$ns" || die "netns add $ns"
		in_ns "$ns" ip link set lo up
		# Every "host" must be a different namespace from the one that holds the guard.
		[ "$(in_ns "$ns" readlink /proc/self/ns/net)" != "$RUNNER_NETNS" ] || die "$ns is the runner's namespace"
	done
	ip link add eth0 netns proxy type veth peer name to-proxy netns wan || die "veth proxy"
	ip link add uplink netns lan type veth peer name to-lan netns wan || die "veth lan"
	ip link add lan0 netns peer type veth peer name to-peer netns lan || die "veth peer"

	in_ns wan ip addr add 192.0.2.2/24 dev to-proxy
	in_ns wan ip addr add 198.18.0.1/30 dev to-lan
	in_ns wan ip addr add "$CLIENT_IN_ZONE/32" dev lo
	in_ns wan ip addr add "$CLIENT_OUT_OF_ZONE/32" dev lo
	in_ns proxy ip addr add "$PROXY_PUBLIC_IP/24" dev eth0
	in_ns lan ip addr add 198.18.0.2/30 dev uplink
	in_ns lan ip addr add 192.168.50.1/24 dev to-peer
	in_ns lan ip addr add "$LAN_HOST_IP/24" dev to-peer
	in_ns peer ip addr add "$PEER_LAN_IP/24" dev lan0

	in_ns wan ip link set to-proxy up
	in_ns wan ip link set to-lan up
	in_ns proxy ip link set eth0 up
	in_ns lan ip link set uplink up
	in_ns lan ip link set to-peer up
	in_ns peer ip link set lan0 up

	in_ns proxy ip route add default via 192.0.2.2 || die "proxy route"
	in_ns lan ip route add default via 198.18.0.1 || die "lan route"
	in_ns peer ip route add default via 192.168.50.1 || die "peer route"

	ns_sysctl wan ip_forward 1 || die "wan ip_forward"
	ns_sysctl lan ip_forward 1 || die "lan ip_forward"
	ns_sysctl peer ip_forward 0 || die "peer ip_forward"
	# scripts/install.sh does this on a real host.
	ns_sysctl proxy ip_forward 1 || die "proxy ip_forward"
	[ "$(in_ns proxy cat /proc/sys/net/ipv4/ip_forward)" = 1 ] || die "proxy ip_forward did not take"
	[ "$(in_ns peer cat /proc/sys/net/ipv4/ip_forward)" = 0 ] || die "sysctls are not per namespace"

	in_ns lan nft -f - <<EOF || die "lan NAT"
table ip lan_nat {
	chain postrouting {
		type nat hook postrouting priority 100;
		oifname "uplink" masquerade
	}
}
EOF
	in_ns peer ping -c1 -W2 198.18.0.1 >/dev/null || die "peer cannot reach the WAN router"
	in_ns wan ping -c1 -W2 "$PROXY_PUBLIC_IP" >/dev/null || die "WAN cannot reach the proxy"

	mkdir -p /etc/evuproxy /etc/wireguard "$ZONE_DIR" || die "dirs"
	chmod 700 /etc/evuproxy
	(umask 077 && wg genkey >/etc/evuproxy/wg-private.key) || die "wg genkey"
	PROXY_PUBLIC_KEY=$(wg pubkey </etc/evuproxy/wg-private.key)
	PEER_PRIVATE_KEY=$(wg genkey)
	PEER_PUBLIC_KEY=$(wg pubkey <<<"$PEER_PRIVATE_KEY")
	write_geo_zones
}

topology_down() {
	local ns
	for ns in $(ip netns list 2>/dev/null | cut -d' ' -f1); do
		# shellcheck disable=SC2046
		kill -9 $(ip netns pids "$ns") 2>/dev/null
		ip netns delete "$ns"
	done
	rm -rf /etc/evuproxy /etc/wireguard
}

# Evuproxy and every rule must have gone to the namespaces, never to the container's own.
runner_namespace_untouched() {
	[ -z "$(nft list ruleset)" ] && [ ! -e "/sys/class/net/$PROXY_IFACE" ] && [ "$(readlink /proc/self/ns/net)" = "$RUNNER_NETNS" ]
}

# Two made-up countries, one per WAN client. Seeded so reloads never reach for ipdeny.com.
write_geo_zones() {
	echo 203.0.113.0/24 >"$ZONE_DIR/xa.zone"
	echo 198.51.100.0/24 >"$ZONE_DIR/xb.zone"
}

# Stdin is the rest of the config (forwarding, geo, input_allows). Writes it and reloads.
apply_config() {
	{
		cat <<EOF
wireguard:
  interface: $PROXY_IFACE
  listen_port: $WG_PORT
  private_key_file: /etc/evuproxy/wg-private.key
  address: $PROXY_TUNNEL_IP/24
network:
  public_interface: eth0
peers:
  - name: peer
    public_key: $PEER_PUBLIC_KEY
    tunnel_ip: $PEER_TUNNEL_IP/32
EOF
		cat
	} >/etc/evuproxy/config.yaml
	proxy_reload
}
proxy_reload() { in_ns proxy evuproxy reload >/tmp/evuproxy-reload.log 2>&1 || { cat /tmp/evuproxy-reload.log; return 1; }; }

# Brings the peer up with the real onboarding script. $1 is the AllowedIPs it gets, which is
# the tunnel subnet when the admin UI writes the command. The shim keeps it off the network:
# the tools are already installed, and this namespace has no way to reach a mirror.
peer_up() {
	local shim=/tmp/e2e-shim
	mkdir -p "$shim"
	printf '#!/bin/sh\nexit 0\n' >"$shim/apt-get"
	chmod +x "$shim/apt-get"
	in_ns peer env PATH="$shim:$PATH" \
		EVUPROXY_WG_PRIVATE_KEY="$PEER_PRIVATE_KEY" \
		EVUPROXY_WG_ADDRESS="$PEER_TUNNEL_IP/32" \
		EVUPROXY_WG_SERVER_PUBLIC_KEY="$PROXY_PUBLIC_KEY" \
		EVUPROXY_WG_ENDPOINT="$PROXY_PUBLIC_IP:$WG_PORT" \
		EVUPROXY_WG_ALLOWED_IPS="$1" \
		EVUPROXY_WG_INTERFACE="$PEER_IFACE" \
		bash /scripts/peer-install.sh >/tmp/peer-install.log 2>&1 || { cat /tmp/peer-install.log; return 1; }
}

wait_for_handshake() {
	local i
	for ((i = 0; i < 20; i++)); do
		[ "$(in_ns proxy wg show "$PROXY_IFACE" latest-handshakes | cut -f2)" -gt 0 ] 2>/dev/null && return 0
		sleep 1
	done
	return 1
}
tunnel_pings() { in_ns proxy ping -c1 -W2 "$PEER_TUNNEL_IP" >/dev/null; }

wait_for_listener() {
	local ns=$1 flag=$2 addr=$3 i
	for ((i = 0; i < 50; i++)); do
		in_ns "$ns" ss -Hln "$flag" | grep -qF "$addr" && return 0
		sleep 0.1
	done
	die "nothing listening on $addr in $ns"
}

# A service answers with the address it saw the client come from, so a probe proves the round
# trip and shows the NAT. It only listens on the given address.
serve_tcp() {
	local ns=$1 ip=$2 port=$3
	# shellcheck disable=SC2016
	in_ns "$ns" socat "TCP-LISTEN:$port,bind=$ip,reuseaddr,fork" 'SYSTEM:echo "tcp-ok from=$SOCAT_PEERADDR"' </dev/null >/dev/null 2>&1 &
	wait_for_listener "$ns" -t "$ip:$port"
}
serve_udp() {
	local ns=$1 ip=$2 port=$3
	# shellcheck disable=SC2016
	in_ns "$ns" socat -T2 "UDP-LISTEN:$port,bind=$ip,reuseaddr,fork" 'SYSTEM:read -r _; echo "udp-ok from=$SOCAT_PEERADDR"' </dev/null >/dev/null 2>&1 &
	wait_for_listener "$ns" -u "$ip:$port"
}

# Print the reply, or nothing when the traffic didn't get through. Each call is a new flow,
# so each one meets the firewall's decision for new connections.
tcp_reply() {
	local ns=$1 src=$2 dst=$3 port=$4
	in_ns "$ns" timeout 6 socat -T2 -t2 - "TCP:$dst:$port,bind=$src,connect-timeout=2" </dev/null 2>/dev/null
}
udp_reply() {
	local ns=$1 src=$2 dst=$3 port=$4
	echo probe | in_ns "$ns" timeout 6 socat -T2 -t2 - "UDP:$dst:$port,bind=$src" 2>/dev/null
}

# For check: "reaches <expected reply> <tcp_reply|udp_reply> <args>" and "blocked <...>".
reaches() {
	local want=$1 reply
	shift
	reply=$("$@")
	[[ $reply == *"$want"* ]] || { log "  wanted '$want', got '$reply'"; return 1; }
}
blocked() {
	local reply
	reply=$("$@")
	[ -z "$reply" ] || { log "  wanted no answer, got '$reply'"; return 1; }
}

# Bytes through a WireGuard interface, both directions added up.
wg_bytes() {
	in_ns "$1" wg show "$2" transfer | cut -f2,3 | tr '\t' '+' | { read -r sum; echo $((sum)); }
}

dump_diagnostics() {
	log "--- diagnostics ---"
	in_ns proxy wg show
	in_ns peer wg show
	in_ns proxy nft list ruleset
	in_ns proxy ip route
	in_ns peer ip route
	log "--- end diagnostics ---"
}
