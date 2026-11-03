#!/bin/bash
# scripts/update.sh with a config the new binary rejects. The scripts, evuproxy and nft are the
# real ones, as root. git, go, systemctl and docker are stand-ins, because the container has no
# clone, toolchain or systemd. Sourced by inside.sh with a fresh topology.

PORT_TCP=18080
UPGRADE=/tmp/upgrade
CLONE=$UPGRADE/repo
PREFIX_DIR=$UPGRADE/prefix
UNITS=$UPGRADE/units
SHIM=$UPGRADE/shim
RESTARTS=$UPGRADE/restarts
OUTPUT=$UPGRADE/output
OLD_BINARY="previous binary"

mkdir -p "$CLONE/scripts" "$PREFIX_DIR/bin" "$UNITS" "$SHIM" || die "dirs"
install -m 0755 /scripts/update.sh /scripts/rebuild.sh "$CLONE/scripts/" || die "copy scripts"
# Only the API unit, so rebuild.sh has no boot unit to refresh.
touch "$UNITS/evuproxy-api.service" "$RESTARTS" || die "units"
printf '#!/bin/sh\nexit 0\n' >"$SHIM/git"
# "Builds" the binary this run is testing.
printf '#!/bin/sh\ncp /usr/local/bin/evuproxy evuproxy\n' >"$SHIM/go"
printf '#!/bin/sh\n[ "$1" = restart ] && echo "$2" >>%s\nexit 0\n' "$RESTARTS" >"$SHIM/systemctl"
chmod +x "$SHIM"/* || die "shims"

run_update() {
	in_ns proxy env PATH="$SHIM:$PATH" PREFIX="$PREFIX_DIR" UNIT_DIR="$UNITS" \
		"$CLONE/scripts/update.sh" >"$OUTPUT" 2>&1
}
output_has() { grep -qF "$1" "$OUTPUT" || { log "  wanted '$1' in:"; cat "$OUTPUT"; return 1; }; }
still_old_binary() { [ "$(cat "$PREFIX_DIR/bin/evuproxy")" = "$OLD_BINARY" ]; }
none_restarted() { [ ! -s "$RESTARTS" ]; }
forward_works() { reaches "tcp-ok" tcp_reply wan "$CLIENT_IN_ZONE" "$PROXY_PUBLIC_IP" "$PORT_TCP"; }

log "=== 1. A live host with a config the new binary rejects ==="
apply_config <<EOF || die "reload"
forwarding:
  routes:
    - proto: tcp
      ports: ["$PORT_TCP"]
      target_ip: $PEER_TUNNEL_IP
geo:
  enabled: false
input_allows: []
EOF
peer_up "$TUNNEL_SUBNET" || die "peer-install.sh"
check "WireGuard handshake" wait_for_handshake
serve_tcp peer "$PEER_TUNNEL_IP" "$PORT_TCP"
check "the forward works before the update" forward_works
good_config=$(cat /etc/evuproxy/config.yaml)
echo "$OLD_BINARY" >"$PREFIX_DIR/bin/evuproxy"

# Valid YAML that validation refuses, as a stricter release would.
sed -i "s/listen_port: $WG_PORT/listen_port: 0/" /etc/evuproxy/config.yaml
run_update
check "update.sh fails" test $? -ne 0
check "it says it stopped" output_has "/etc/evuproxy/config.yaml did not pass validation with the new evuproxy binary; stopping."
check "and that nothing changed" output_has "nothing was restarted"
check "and gives the cause" output_has "listen_port"
check "and doesn't claim success" eval '! grep -qF "Update complete" "$OUTPUT"'
check "the binary wasn't installed" still_old_binary
check "no service was restarted" none_restarted
check "the forward still works" forward_works

log "=== 2. The next run, with the config fixed, goes through ==="
echo "$good_config" >/etc/evuproxy/config.yaml
run_update
check "update.sh succeeds" test $? -eq 0
check "it validated first" output_has "Validating /etc/evuproxy/config.yaml"
check "the new binary is installed" cmp /usr/local/bin/evuproxy "$PREFIX_DIR/bin/evuproxy"
check "the service was restarted" grep -qxF evuproxy-api.service "$RESTARTS"
check "validating left the rules alone: the forward still works" forward_works
