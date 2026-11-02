#!/bin/bash
# Runs inside the container (see README.md). Boots a throwaway Debian VM with user-mode
# networking, installs EvuProxy the way scripts/install.sh lays it out, and tests
# confirm-or-revert from outside the VM. SSH and the API are only reachable through
# ports QEMU forwards on the container's loopback, so the firewall under test sits
# between this script and the VM. Everything lives in the container's writable layer.
set -uo pipefail

log() { echo "[$(date +%H:%M:%S)] $*"; }
failures=0
check() {
	local name=$1
	shift
	if "$@"; then
		log "PASS: $name"
	else
		log "FAIL: $name"
		failures=$((failures + 1))
	fi
}
die() {
	log "SETUP FAILED: $*"
	[ -f /vm/serial.log ] && tail -40 /vm/serial.log
	exit 100
}

mkdir -p /vm
cd /vm || exit 100
apk add --no-cache -q curl jq openssh-client qemu-img qemu-system-x86_64 xorriso || die "apk add"

IMAGE_BASE=https://cloud.debian.org/images/cloud/bookworm/latest
IMAGE_NAME=debian-12-genericcloud-amd64.qcow2
curl -fsSLO "$IMAGE_BASE/$IMAGE_NAME" || die "download image"
curl -fsSL "$IMAGE_BASE/SHA512SUMS" | grep " $IMAGE_NAME\$" | sha512sum -c - || die "image checksum"
mv "$IMAGE_NAME" base.qcow2

ssh-keygen -q -t ed25519 -N '' -f /vm/id_ed25519
qemu-img create -q -f qcow2 -F qcow2 -b base.qcow2 disk.qcow2 6G
cat >user-data <<EOF
#cloud-config
disable_root: false
ssh_authorized_keys:
  - $(cat /vm/id_ed25519.pub)
packages:
  - nftables
  - wireguard-tools
EOF
cat >meta-data <<EOF
instance-id: evuproxy-rollback-vm
local-hostname: evuproxy-rollback-vm
EOF
xorriso -as genisoimage -quiet -output seed.iso -volid cidata -joliet -rock user-data meta-data

qemu-system-x86_64 \
	-enable-kvm -cpu host -smp 2 -m 1024 \
	-display none -serial file:/vm/serial.log \
	-drive file=disk.qcow2,if=virtio \
	-drive file=seed.iso,if=virtio,format=raw,media=cdrom \
	-netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:9847-:9847 \
	-device virtio-net-pci,netdev=n0 &

SSH_BASE=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i /vm/id_ed25519 -p 2222)
# A new connection, which is what the firewall under test decides on.
vm() { ssh "${SSH_BASE[@]}" -o ControlPath=none -o ConnectTimeout=5 -o ConnectionAttempts=1 root@127.0.0.1 "$@"; }
scp_vm() { scp -O -q -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -i /vm/id_ed25519 -P 2222 "$@"; }
# An established connection. The ruleset accepts those, so this one outlives the cut and
# stands in for the operator's already-open shell.
open_held_shell() {
	ssh "${SSH_BASE[@]}" -o ControlMaster=yes -o ControlPath=/vm/held.sock -o ControlPersist=600 -o ServerAliveInterval=0 -fN root@127.0.0.1
}
held() { ssh "${SSH_BASE[@]}" -o ControlPath=/vm/held.sock root@127.0.0.1 "$@"; }
close_held_shell() { ssh -o ControlPath=/vm/held.sock -O exit root@127.0.0.1 2>/dev/null; rm -f /vm/held.sock; }

ssh_works() { vm true 2>/dev/null; }
ssh_cut() { ! ssh_works; }
wait_for_ssh() {
	local seconds=$1 i
	for ((i = 0; i < seconds; i += 2)); do
		ssh_works && return 0
		sleep 2
	done
	return 1
}
now() { date +%s; }

log "booting VM"
wait_for_ssh 240 || die "no SSH after 240s"
vm cloud-init status --wait >/dev/null || die "cloud-init"
log "VM up: $(vm uname -r), $(vm systemd-run --version | head -1)"
vm test -x /usr/sbin/nft -a -x /usr/bin/wg || die "nft or wg missing"

# Install the way scripts/install.sh does.
scp_vm /rollback-vm/evuproxy root@127.0.0.1:/usr/local/bin/evuproxy || die "copy binary"
scp_vm /templates/evuproxy.service /templates/evuproxy-api.service root@127.0.0.1:/etc/systemd/system/ || die "copy units"
PUB_IF=$(vm "ip -o route show default | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -1")
TOKEN=rollback-vm-token
vm bash -s <<EOF || die "install"
set -e
mkdir -p /etc/evuproxy /etc/systemd/system/evuproxy-api.service.d
wg genkey >/etc/evuproxy/wg-private.key
chmod 600 /etc/evuproxy/wg-private.key
echo "$TOKEN" >/etc/evuproxy/api.token
chmod 600 /etc/evuproxy/api.token
# The API has to be reachable from outside for this test; the installed unit binds loopback.
cat >/etc/systemd/system/evuproxy-api.service.d/listen.conf <<UNIT
[Service]
ExecStart=
ExecStart=/usr/local/bin/evuproxy serve --config /etc/evuproxy/config.yaml --listen 0.0.0.0:9847 --token-file /etc/evuproxy/api.token
UNIT
EOF
PEER_KEY=$(vm "wg genkey | wg pubkey")

# $1: extra input_allows rows, on top of WireGuard. Comment $2 tells configs apart.
write_config() {
	cat <<EOF
wireguard:
  interface: evuproxy0
  listen_port: 51830
  private_key_file: /etc/evuproxy/wg-private.key
  address: 10.100.0.1/24
network:
  public_interface: $PUB_IF
forwarding:
  routes: []
geo:
  enabled: false
apply:
  confirm: true
input_allows:
  - proto: udp
    dport: "51830"
$1
peers:
  - name: p1
    public_key: $PEER_KEY
    tunnel_ip: 10.100.0.2/32
# $2
EOF
}
OPEN_RULES='  - proto: tcp
    dport: "22"
  - proto: tcp
    dport: "9847"'
# Neither SSH nor the API: this is the config that locks the operator out.
LOCKED_RULES='  - proto: tcp
    dport: "9848"'

put_config() { write_config "$1" "$2" | vm "cat >/etc/evuproxy/config.yaml"; }
api() { curl -sS -m 10 -H "X-API-Token: $TOKEN" "$@"; }
api_url=http://127.0.0.1:9847/api/v1
wait_for_api() {
	local i
	for ((i = 0; i < 30; i++)); do
		curl -fsS -m 3 http://127.0.0.1:9847/healthz >/dev/null 2>&1 && return 0
		sleep 1
	done
	return 1
}
session_phase() { api "$api_url/apply/session" | jq -r '.session.phase // "none"'; }
reset_host() {
	put_config "$OPEN_RULES" "${1:-baseline}"
	vm evuproxy reload || die "baseline reload"
	vm rm -f /etc/evuproxy/config.yaml.reverted /etc/evuproxy/.evuproxy-apply-last-revert.json
}
config_comment() { held tail -1 /etc/evuproxy/config.yaml 2>/dev/null || vm tail -1 /etc/evuproxy/config.yaml; }
live_rules_allow_ssh() { vm nft list table inet evuproxy | grep -q 'tcp dport 22'; }

put_config "$OPEN_RULES" baseline
vm "systemctl daemon-reload && systemctl enable evuproxy.service evuproxy-api.service >/dev/null 2>&1 && systemctl start evuproxy.service evuproxy-api.service" || die "start services"
wait_for_api || die "API did not come up"
check "baseline firewall is live and SSH works through it" live_rules_allow_ssh

log "=== 1. Timeout with the API stopped: the case the issue asks for ==="
open_held_shell || die "held shell"
put_config "$LOCKED_RULES" locked-out
t0=$(now)
resp=$(api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":30}')
log "POST /reload: $resp"
check "Apply answered with an active session" test "$(jq -r '.session.phase' <<<"$resp")" = active
held systemctl list-timers --all --no-pager 'evuproxy-apply-revert-*' | head -3
check "new SSH connections are cut" ssh_cut
check "the API is cut too" bash -c '! curl -fsS -m 3 http://127.0.0.1:9847/healthz'
check "the live firewall no longer has an SSH rule" bash -c "! ssh ${SSH_BASE[*]} -o ControlPath=/vm/held.sock root@127.0.0.1 nft list table inet evuproxy | grep -q 'tcp dport 22'"
held systemctl stop evuproxy-api.service
check "the API is stopped" bash -c "[ \"\$(ssh ${SSH_BASE[*]} -o ControlPath=/vm/held.sock root@127.0.0.1 systemctl is-active evuproxy-api.service)\" != active ]"
close_held_shell
log "held shell closed; nothing but the timer can fix this now. Waiting for SSH."
check "SSH comes back by itself" wait_for_ssh 60
t1=$(now)
log "SSH was back $((t1 - t0))s after the Apply, for a 30s window"
check "it took about the window, not sooner" test $((t1 - t0)) -ge 25
check "the API stayed stopped throughout" bash -c "[ \"\$(ssh ${SSH_BASE[*]} -o ControlPath=none root@127.0.0.1 systemctl is-active evuproxy-api.service)\" != active ]"
check "the firewall is back" live_rules_allow_ssh
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "config.yaml.bak is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml.bak)" = "# baseline"
check "the rejected config was kept" test "$(vm tail -1 /etc/evuproxy/config.yaml.reverted)" = "# locked-out"
log "journal of the revert:"
vm journalctl --no-pager -n 6 -u 'evuproxy-apply-revert-*' || true
check "the revert is in the event log" vm grep -q apply_reverted /etc/evuproxy/state/events.jsonl
check "no revert timer is left" bash -c "[ -z \"\$(ssh ${SSH_BASE[*]} -o ControlPath=none root@127.0.0.1 systemctl list-units --all --no-legend 'evuproxy-apply-revert-*')\" ]"
vm systemctl start evuproxy-api.service
wait_for_api || die "API did not restart"
status=$(api "$api_url/apply/session")
log "GET /apply/session after restart: $status"
check "the API reports the revert after starting again" test "$(jq -r '.last_revert.reason' <<<"$status")" = timeout

log "=== 2. Confirm keeps the change ==="
reset_host baseline
put_config "$OPEN_RULES" confirmed
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":15}' >/dev/null
check "a session is waiting" test "$(session_phase)" = active
check "confirm succeeds" test "$(api -X POST "$api_url/apply/confirm" | jq -r .result)" = confirmed
sleep 20
check "past the deadline the change is still there" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# confirmed"
check "no session is left" test "$(session_phase)" = none

log "=== 3. Repeat Apply restarts the wait and keeps the revert target ==="
reset_host baseline
put_config "$OPEN_RULES" first-try
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":20}' >/dev/null
sleep 12
put_config "$OPEN_RULES" second-try
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":20}' >/dev/null
sleep 12
check "24s in, the first timer did not revert" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# second-try"
check "the session is still active" test "$(session_phase)" = active
sleep 15
check "the restarted timer reverts" test "$(session_phase)" = none
check "to the last confirmed config, not the first try" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "and keeps the latest attempt" test "$(vm tail -1 /etc/evuproxy/config.yaml.reverted)" = "# second-try"

log "=== 4. An API restart during the window leaves the session running ==="
reset_host baseline
put_config "$OPEN_RULES" across-restart
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":20}' >/dev/null
vm systemctl restart evuproxy-api.service
wait_for_api || die "API did not restart"
remaining=$(api "$api_url/apply/session" | jq -r '.session.remaining_seconds')
log "remaining after restart: ${remaining}s"
check "the restarted API picks the countdown up" test "${remaining:-0}" -gt 0
check "config.yaml was left alone" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# across-restart"
sleep 25
check "the timer still reverts" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"

log "=== 5. One-way reload is refused during the window ==="
reset_host baseline
put_config "$OPEN_RULES" refused
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":60}' >/dev/null
check "POST /reload with no body gets 409" test "$(api -o /dev/null -w '%{http_code}' -X POST "$api_url/reload")" = 409
vm evuproxy reload 2>/dev/null
check "evuproxy reload fails" test $? -ne 0
check "reload-status shows the session" test "$(vm evuproxy reload-status | jq -r .session.phase)" = active
check "evuproxy reload-revert reverts" vm evuproxy reload-revert
check "to the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"

log "=== 6. CLI and existing behavior ==="
reset_host baseline
put_config "$OPEN_RULES" plain
check "plain evuproxy reload still works" vm evuproxy reload
check "and leaves no session" test "$(session_phase)" = none
put_config "$OPEN_RULES" via-cli
check "evuproxy reload --confirm-within works" vm evuproxy reload --confirm-within 60s
check "evuproxy reload-confirm works" vm evuproxy reload-confirm
check "the CLI session kept its config" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# via-cli"

log "=== 7. A failed rollback is recorded, then retried ==="
reset_host baseline
put_config "$OPEN_RULES" fails-to-revert
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":12}' >/dev/null
vm mv /usr/sbin/nft /usr/sbin/nft.off
log "nft moved away; waiting for the timer and its retries"
sleep 40
status=$(api "$api_url/apply/session")
log "GET /apply/session: $status"
check "the failure is reported" test "$(jq -r '.session.phase' <<<"$status")" = failed
check "with the reason" bash -c "jq -e '.session.failure | length > 0' <<<'$status' >/dev/null"
check "the failure is in the event log" vm grep -q apply_revert_failed /etc/evuproxy/state/events.jsonl
check "another Apply is refused while it stands" test "$(api -o /dev/null -w '%{http_code}' -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":30}')" = 409
vm mv /usr/sbin/nft.off /usr/sbin/nft
check "retry succeeds once nft is back" test "$(api -X POST "$api_url/apply/revert" | jq -r .result)" = reverted
check "and clears the session" test "$(session_phase)" = none

log "=== 8. A reboot during the window reverts at boot ==="
reset_host baseline
put_config "$LOCKED_RULES" locked-across-reboot
open_held_shell || die "held shell"
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":600}' >/dev/null
check "SSH is cut before the reboot" ssh_cut
held systemctl reboot || true
close_held_shell
sleep 10
check "SSH comes back after the reboot, long before the 600s window" wait_for_ssh 120
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "the firewall is back" live_rules_allow_ssh
wait_for_api || die "API did not come back"
status=$(api "$api_url/apply/session")
log "GET /apply/session: $status"
check "it was reported as interrupted" test "$(jq -r '.last_revert.reason' <<<"$status")" = interrupted
check "no session is left" test "$(jq -r '.session' <<<"$status")" = null

log "=== RESULT: $failures failed ==="
if [ "$failures" -ne 0 ]; then
	vm journalctl --no-pager -n 40 -u 'evuproxy*' || true
fi
exit "$failures"
