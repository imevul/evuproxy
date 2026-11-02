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
  - nginx-light
  - git
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
	-netdev user,id=n0,hostfwd=tcp:127.0.0.1:2222-:22,hostfwd=tcp:127.0.0.1:9847-:9847,hostfwd=tcp:127.0.0.1:9080-:9080 \
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

# KEEP_ONLY=1 skips to the "Keep needs a new connection" section at the end.
host_sections() {
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
# SSH can answer before the boot unit has finished reverting.
vm systemctl is-system-running --wait >/dev/null 2>&1
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "the firewall is back" live_rules_allow_ssh
wait_for_api || die "API did not come back"
status=$(api "$api_url/apply/session")
log "GET /apply/session: $status"
check "it was reported as interrupted" test "$(jq -r '.last_revert.reason' <<<"$status")" = interrupted
check "no session is left" test "$(jq -r '.session' <<<"$status")" = null

log "=== 9. A failed Apply and failed revert stay out of config.yaml across reboots ==="
reset_host baseline
reboot_and_wait() {
	vm systemctl reboot || true
	sleep 10
	wait_for_ssh 120 || return 1
	vm systemctl is-system-running --wait >/dev/null 2>&1
	return 0
}
put_config "$LOCKED_RULES" failed-apply
# reload loads the firewall before WireGuard, so this fails the Apply with the new
# firewall live, and fails every revert attempt the same way after restoring the old one.
vm mv /usr/bin/wg /usr/bin/wg.off
code=$(curl -sS -m 90 -o /dev/null -w '%{http_code}' -H "X-API-Token: $TOKEN" -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":600}')
check "the Apply is refused as a failed revert" test "$code" = 409
check "SSH works: the firewall went back before WireGuard failed" ssh_works
check "the failure is reported" test "$(vm evuproxy reload-status | jq -r .session.phase)" = failed
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
log "rebooting with WireGuard still broken"
check "the VM comes back" reboot_and_wait
check "the firewall is the baseline, not the failed config" live_rules_allow_ssh
check "config.yaml is still the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
# The boot unit and the API's startup each retry the revert, one after the other.
settled_phase() {
	local phase i
	for ((i = 0; i < 60; i++)); do
		phase=$(vm evuproxy reload-status | jq -r .session.phase)
		[ "$phase" != rolling_back ] && break
		sleep 1
	done
	echo "$phase"
}
check "the failure still stands" test "$(settled_phase)" = failed
vm mv /usr/bin/wg.off /usr/bin/wg
log "rebooting with WireGuard fixed: the revert now succeeds at boot"
check "the VM comes back" reboot_and_wait
status=$(vm evuproxy reload-status)
log "evuproxy reload-status: $status"
check "the session is gone" test "$(jq -r '.session' <<<"$status")" = null
check "it says why" test "$(jq -r '.last_revert.reason' <<<"$status")" = failed_apply
check "the firewall is the baseline, not the failed config" live_rules_allow_ssh
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "the failed edits were kept" test "$(vm tail -1 /etc/evuproxy/config.yaml.reverted)" = "# failed-apply"
check "a later boot's reload still applies the baseline" vm evuproxy reload
check "SSH still works after it" ssh_works
check "the firewall is still the baseline" live_rules_allow_ssh

log "=== 10. A revert killed partway offers a retry ==="
wait_for_api || die "API did not come back"
reset_host baseline
put_config "$OPEN_RULES" killed-revert
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":10}' >/dev/null
vm mv /usr/sbin/nft /usr/sbin/nft.off
phase=active
for ((i = 0; i < 30; i++)); do
	phase=$(session_phase)
	[ "$phase" = rolling_back ] && break
	sleep 0.5
done
check "the timer started the revert" test "$phase" = rolling_back
vm "systemctl kill --signal=SIGKILL 'evuproxy-apply-revert-*.service'"
sleep 1
status=$(api "$api_url/apply/session")
log "GET /apply/session: $status"
check "the killed revert reads as failed" test "$(jq -r '.session.phase' <<<"$status")" = failed
vm mv /usr/sbin/nft.off /usr/sbin/nft
check "retry succeeds" test "$(api -X POST "$api_url/apply/revert" | jq -r .result)" = reverted
check "and clears the session" test "$(session_phase)" = none
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"

log "=== 11. A reboot keeps unapplied edits off the host ==="
reset_host baseline
live_rules_allow_marker() { vm nft list table inet evuproxy | grep -q 'tcp dport 9849'; }
MARKER_RULES="$OPEN_RULES
  - proto: tcp
    dport: \"9849\""
put_config "$LOCKED_RULES" saved-locked
check "the VM comes back past a saved lockout" reboot_and_wait
check "the firewall is the baseline" live_rules_allow_ssh
check "config.yaml still holds the edits" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# saved-locked"
check "config.yaml.bak is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml.bak)" = "# baseline"
wait_for_api || die "API did not come back"
check "they show as unapplied changes" test "$(api "$api_url/pending" | jq -r .pending)" = true
check "the journal says so" bash -c "ssh ${SSH_BASE[*]} -o ControlPath=none root@127.0.0.1 journalctl -b --no-pager -u evuproxy.service | grep -q 'unapplied changes'"
check "restarting the unit doesn't apply them either" vm systemctl restart evuproxy.service
check "SSH still works after it" ssh_works
check "the firewall is still the baseline" live_rules_allow_ssh
put_config "$MARKER_RULES" hand-reload
check "a hand reload applies edits" vm evuproxy reload
check "they are live" live_rules_allow_marker
check "and are the new baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml.bak)" = "# hand-reload"

log "=== 12. An edit can't turn confirm off to get itself applied at boot ==="
reset_host baseline
write_config "$MARKER_RULES" confirm-off-edit | sed 's/confirm: true/confirm: false/' | vm "cat >/etc/evuproxy/config.yaml"
check "the VM comes back" reboot_and_wait
check "the edit is not live" bash -c "! ssh ${SSH_BASE[*]} -o ControlPath=none root@127.0.0.1 nft list table inet evuproxy | grep -q 'tcp dport 9849'"
check "and is still in config.yaml" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# confirm-off-edit"

log "=== 13. With confirm off, or no usable .bak, a reboot applies config.yaml as before ==="
write_config "$OPEN_RULES" confirm-off | sed 's/confirm: true/confirm: false/' | vm "cat >/etc/evuproxy/config.yaml"
vm evuproxy reload || die "confirm-off reload"
write_config "$MARKER_RULES" confirm-off-hand-edit | sed 's/confirm: true/confirm: false/' | vm "cat >/etc/evuproxy/config.yaml"
check "the VM comes back" reboot_and_wait
check "confirm off: the hand edit is live" live_rules_allow_marker
check "confirm off: and is the new baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml.bak)" = "# confirm-off-hand-edit"
reset_host baseline
put_config "$MARKER_RULES" no-bak
vm rm -f /etc/evuproxy/config.yaml.bak
check "the VM comes back" reboot_and_wait
check "no .bak: config.yaml is live" live_rules_allow_marker
check "no .bak: and it is recorded" test "$(vm tail -1 /etc/evuproxy/config.yaml.bak)" = "# no-bak"

log "=== 14. A failed Apply's edits stay off the host at reboot ==="
wait_for_api || die "API did not come back"
reset_host baseline
# Fails this many `wg syncconf` calls, then works. /run clears at reboot.
vm bash -s <<'EOF' || die "wg wrapper"
mv /usr/bin/wg /usr/bin/wg.real
cat >/usr/bin/wg <<'WRAP'
#!/bin/bash
if [ "$1" = syncconf ] && [ -s /run/wg-failures ] && [ "$(cat /run/wg-failures)" -gt 0 ]; then
	echo $(($(cat /run/wg-failures) - 1)) >/run/wg-failures
	echo "wg: failing on purpose" >&2
	exit 1
fi
exec /usr/bin/wg.real "$@"
WRAP
chmod 755 /usr/bin/wg
EOF
put_config "$LOCKED_RULES" failed-revert-worked
vm "echo 1 >/run/wg-failures"
code=$(curl -sS -m 90 -o /dev/null -w '%{http_code}' -H "X-API-Token: $TOKEN" -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":600}')
log "POST /reload answered $code"
check "the Apply failed" test "$code" != 200
check "SSH works: its revert did" ssh_works
check "no session is left" test "$(session_phase)" = none
check "the edits are back as unapplied changes" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# failed-revert-worked"
check "the VM comes back" reboot_and_wait
check "the firewall is the baseline" live_rules_allow_ssh
check "the edits are still unapplied" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# failed-revert-worked"

wait_for_api || die "API did not come back"
reset_host baseline
put_config "$LOCKED_RULES" failed-then-retried
# The Apply, then all three revert attempts.
vm "echo 4 >/run/wg-failures"
code=$(curl -sS -m 90 -o /dev/null -w '%{http_code}' -H "X-API-Token: $TOKEN" -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":600}')
check "the Apply is refused as a failed revert" test "$code" = 409
check "the failure is reported" test "$(vm evuproxy reload-status | jq -r .session.phase)" = failed
check "Retry revert succeeds" test "$(api -X POST "$api_url/apply/revert" | jq -r .result)" = reverted
check "the edits are back as unapplied changes" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# failed-then-retried"
check "the VM comes back" reboot_and_wait
check "the firewall is the baseline" live_rules_allow_ssh
check "the edits are still unapplied" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# failed-then-retried"
vm mv /usr/bin/wg.real /usr/bin/wg

log "=== 15. The update that brings in --boot installs it before restarting the unit ==="
wait_for_api || die "API did not come back"
reset_host baseline
use_old_unit() { vm "sed -i 's/ --boot//' /etc/systemd/system/evuproxy.service && systemctl daemon-reload && systemctl restart evuproxy.service"; }
unit_has_boot() { vm "grep -q 'reload --boot' /etc/systemd/system/evuproxy.service && systemctl show -p ExecStart evuproxy.service | grep -q 'reload --boot'"; }
use_old_unit || die "old unit"
scp_vm /scripts/update.sh /scripts/rebuild.sh /scripts/update-boot-unit.sh root@127.0.0.1:/root/ || die "copy scripts"
# A clone on the old release, about to pull this one. Bash keeps running the update.sh it
# opened, and this update.sh has the same body as the old one. The old rebuild.sh mustn't
# run, so it fails. The go stand-in "builds" the binary already installed.
vm bash -s <<'EOF' || die "update flow setup"
set -e
printf '#!/bin/sh\ncp /usr/local/bin/evuproxy evuproxy\n' >/usr/local/bin/go
chmod 755 /usr/local/bin/go
git config --global user.email vm@example.invalid
git config --global user.name vm
git init -q --bare -b main /root/origin.git
git clone -q /root/origin.git /root/evuproxy 2>/dev/null
cd /root/evuproxy
mkdir scripts
cp /root/update.sh scripts/update.sh
printf '#!/bin/sh\nexit 1\n' >scripts/rebuild.sh
chmod 755 scripts/rebuild.sh
git add .
git commit -qm old
git push -qu origin main
git clone -q /root/origin.git /root/next
cd /root/next
mkdir templates
cp /root/rebuild.sh /root/update-boot-unit.sh scripts/
EOF
scp_vm /templates/evuproxy.service root@127.0.0.1:/root/next/templates/ || die "copy template"
vm "cd /root/next && git add . && git commit -qm new && git push -q" || die "push new release"
put_config "$LOCKED_RULES" saved-before-update
vm /root/evuproxy/scripts/update.sh
check "update.sh succeeds" test $? -eq 0
check "the pull brought in the new rebuild.sh" vm grep -q update-boot-unit /root/evuproxy/scripts/rebuild.sh
check "the unit has --boot, and systemd has loaded it" unit_has_boot
check "SSH still works: the update's restart kept the edits off the host" ssh_works
check "the firewall is the baseline" live_rules_allow_ssh
check "the edits are still unapplied" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# saved-before-update"
check "the VM comes back past them" reboot_and_wait
check "the firewall is still the baseline" live_rules_allow_ssh

wait_for_api || die "API did not come back"
reset_host baseline
use_old_unit || die "old unit"
put_config "$OPEN_RULES" window-during-refresh
api -X POST "$api_url/reload" -d '{"confirm_timeout_seconds":20}' >/dev/null
check "a session is waiting" test "$(session_phase)" = active
check "rebuild.sh --install succeeds in the window" vm "cd /root/evuproxy && scripts/rebuild.sh --install"
check "the unit has --boot" unit_has_boot
check "the session is still active" test "$(session_phase)" = active
sleep 25
check "its timer still reverts" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "and clears the session" test "$(session_phase)" = none
}
[ "${KEEP_ONLY:-}" = 1 ] || host_sections

log "=== 16. Keep needs a new connection ==="
# The real panel in a real browser, outside the VM, through the real docker/nginx.conf.
apk add --no-cache -q chromium nodejs npm || die "apk add browser"
mkdir -p /vm/browser
cp /rollback-vm/keep.mjs /vm/browser/ || die "copy keep.mjs"
(cd /vm/browser && npm init -y >/dev/null && npm install --silent --no-audit --no-fund playwright-core) || die "npm install"
vm "rm -rf /usr/share/nginx/html && mkdir -p /usr/share/nginx" || die "web dir"
scp_vm -r /web root@127.0.0.1:/usr/share/nginx/html || die "copy web"
# Rules with the panel's port open, on top of what OPEN_RULES allows.
PANEL_RULES="$OPEN_RULES
  - proto: tcp
    dport: \"9080\""
# $1: the nginx config, filled in the way docker/entrypoint.sh does. Log each request's
# connection, so the log shows which ones reached nginx and how many connections they used.
install_nginx() {
	sed -e 's|__API_HOST__|127.0.0.1:9847|g' -e 's|__UI_LISTEN__|0.0.0.0:9080|g' "$1" |
		vm "cat >/etc/nginx/conf.d/default.conf; rm -f /etc/nginx/sites-enabled/default; printf '%s\n' \"log_format evu '\\\$connection \\\$time_iso8601 \\\$status \\\$remote_addr \\\$request';\" 'access_log /var/log/nginx/evu.log evu;' >/etc/nginx/conf.d/00-log.conf; : >/var/log/nginx/evu.log; nginx -t -q && systemctl restart nginx"
}
# The same config with connections kept open, as it shipped before this change.
sed -e 's/keepalive_timeout 0;/keepalive_timeout 65;/' -e '/client_header_timeout 5s;/d' /docker/nginx.conf >/vm/nginx.keepalive.conf
grep -q 'keepalive_timeout 65;' /vm/nginx.keepalive.conf || die "keep-alive control config"
grep -q 'keepalive_timeout 0;' /docker/nginx.conf || die "shipped config does not close connections"

# Drives the browser through an Apply and stops before Keep, so the checks below run with
# the panel still open. Sets browser_pid. $1: the name for this run's output.
start_panel() {
	rm -f /vm/browser/applied /vm/browser/press /vm/browser/finish "/vm/browser/$1.json"
	# exec, so browser_pid is node itself and can be killed.
	(cd /vm/browser && BROWSER_OUT="$1.json" TOKEN="$TOKEN" exec node keep.mjs) &
	browser_pid=$!
	local i
	for ((i = 0; i < 90; i++)); do
		[ -f /vm/browser/applied ] && return 0
		kill -0 "$browser_pid" 2>/dev/null || return 1
		sleep 1
	done
	return 1
}
# Presses Keep and waits for the page to report what came of it.
press_keep() {
	touch /vm/browser/press
	local i
	for ((i = 0; i < 40; i++)); do
		[ -s "/vm/browser/$1.json" ] && return 0
		sleep 1
	done
	return 1
}
finish_panel() { touch /vm/browser/finish; wait "$browser_pid" 2>/dev/null; }
outcome() { jq -r ".$2" "/vm/browser/$1.json"; }
panel_session() {
	held curl -sS -m 5 -H "X-API-Token:\ $TOKEN" http://127.0.0.1:9080/api/v1/apply/session | jq -r '.session.phase // "none"'
}
confirm_posts_seen() { held grep -c apply/confirm /var/log/nginx/evu.log; }
panel_reachable_new() { curl -fsS -m 3 http://127.0.0.1:9080/healthz >/dev/null 2>&1; }
panel_cut() { ! panel_reachable_new; }
# Counts SYNs to the panel that reach the end of the input chain, where the policy drops them.
count_dropped_syns() { held nft add rule inet evuproxy input tcp dport 9080 tcp flags syn counter; }
dropped_syns() { held nft list chain inet evuproxy input | sed -n 's/.*tcp dport 9080 tcp flags syn.*counter packets \([0-9]*\).*/\1/p'; }
reset_panel_host() {
	put_config "$PANEL_RULES" baseline
	vm evuproxy reload || die "baseline reload"
	vm rm -f /etc/evuproxy/config.yaml.reverted /etc/evuproxy/.evuproxy-apply-last-revert.json
	wait_for_api || die "API after baseline reload"
	put_config "$LOCKED_RULES" locked-out
}

log "--- Control: with keep-alive on, the lockout can be confirmed. This is the bug. ---"
install_nginx /vm/nginx.keepalive.conf || die "install keep-alive nginx"
reset_panel_host
open_held_shell || die "held shell"
start_panel keepalive || die "panel did not reach the Keep prompt"
check "control: new SSH connections are cut" ssh_cut
check "control: new connections to the panel are cut" panel_cut
press_keep keepalive || die "control: no outcome from Keep"
log "control outcome: $(cat /vm/browser/keepalive.json)"
finish_panel
check "control: Keep succeeded over the surviving connection" test "$(outcome keepalive kept)" = true
check "control: no session is left to revert" test "$(panel_session)" = none
check "control: the locked config is now the confirmed one" test "$(held tail -1 /etc/evuproxy/config.yaml)" = "# locked-out"
log "recovering the control host from its own held shell"
held "cat >/etc/evuproxy/config.yaml" < <(write_config "$PANEL_RULES" baseline)
held evuproxy reload || die "control recovery"
close_held_shell

log "--- Shipped config: Keep fails after a cut, and the timer reverts ---"
install_nginx /docker/nginx.conf || die "install nginx"
reset_panel_host
open_held_shell || die "held shell"
t0=$(now)
start_panel shipped || die "panel did not reach the Keep prompt"
check "new SSH connections are cut" ssh_cut
check "new connections to the panel are cut" panel_cut
count_dropped_syns
before_syns=$(dropped_syns)
press_keep shipped || die "no outcome from Keep"
log "outcome: $(cat /vm/browser/shipped.json)"
after_syns=$(dropped_syns)
log "SYNs to the panel dropped by the firewall while Keep waited: $before_syns then $after_syns"
log "nginx's log of confirm requests, now $(held date -Iseconds): [$(held grep apply/confirm /var/log/nginx/evu.log)]"
check "Keep did not succeed" test "$(outcome shipped kept)" = false
check "the page says no answer came" bash -c "jq -r .note /vm/browser/shipped.json | grep -q 'No answer from the host'"
check "the page still counts down" bash -c "jq -r .detail /vm/browser/shipped.json | grep -q 'Reverting in'"
check "the firewall dropped new connections to the panel" test "${after_syns:-0}" -gt "${before_syns:-0}"
check "Keep never reached nginx" test "$(confirm_posts_seen)" = 0
check "nginx and the API still work: only the connection was missing" test "$(panel_session)" = active
close_held_shell
check "SSH comes back by itself" wait_for_ssh 90
t1=$(now)
log "SSH was back $((t1 - t0))s after the Apply started"
finish_panel
check "the page reports the revert" bash -c "jq -e '.afterRevert | test(\"Reverted to the last confirmed config\")' /vm/browser/shipped.json >/dev/null"
check "config.yaml is the baseline" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# baseline"
check "the rejected config was kept" test "$(vm tail -1 /etc/evuproxy/config.yaml.reverted)" = "# locked-out"
# QEMU's user-mode networking accepts for the guest and may still be holding the request the
# browser gave up on, and delivers it once the guest answers. A real network doesn't: closing
# a socket that is still connecting stops its SYNs. Either way it must not count as a Keep.
log "nginx's log of confirm requests after the revert: [$(vm grep apply/confirm /var/log/nginx/evu.log)]"
late_keep_refused() { ! vm grep apply/confirm /var/log/nginx/evu.log | grep -qE '^[0-9]+ [^ ]+ 2[0-9][0-9] '; }
check "a Keep arriving after the revert is not accepted" late_keep_refused

log "--- Shipped config: the failure above is the connection, not Keep ---"
reset_panel_host
put_config "$PANEL_RULES" still-open
start_panel open || die "panel did not reach the Keep prompt"
press_keep open || die "no outcome from Keep"
log "outcome: $(cat /vm/browser/open.json)"
finish_panel
check "with new connections allowed, the same button keeps the change" test "$(outcome open kept)" = true
check "and the config stays" test "$(vm tail -1 /etc/evuproxy/config.yaml)" = "# still-open"
check "with one connection per request" bash -c "[ \"\$(ssh ${SSH_BASE[*]} -o ControlPath=none root@127.0.0.1 \"cut -d' ' -f1 /var/log/nginx/evu.log | sort | uniq -d | wc -l\")\" = 0 ]"
log "page load: $(outcome open pageLoadRequests) requests, so that many connections"

reset_panel_host
open_held_shell || die "held shell"
start_panel loopback || die "panel did not reach the Keep prompt"
check "cut again" panel_cut
loopback_result=$(held curl -sS -m 10 -H "X-API-Token:\ $TOKEN" -X POST http://127.0.0.1:9080/api/v1/apply/confirm | jq -r .result)
check "the same request from inside the VM confirms, so the route itself is fine" test "$loopback_result" = confirmed
kill "$browser_pid" 2>/dev/null
wait "$browser_pid" 2>/dev/null
held "cat >/etc/evuproxy/config.yaml" < <(write_config "$PANEL_RULES" baseline)
held evuproxy reload || die "recovery"
close_held_shell

log "--- Shipped config: connections don't linger ---"
reset_panel_host
exec 3<>/dev/tcp/127.0.0.1/9080
printf 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n' >&3
reply=$(timeout 5 cat <&3)
exec 3<&-
check "nginx answers Connection: close and hangs up" bash -c "grep -qi '^connection: close' <<<'$reply'"
# A socket opened ahead of time and never used, like a browser's spare.
exec 3<>/dev/tcp/127.0.0.1/9080
sleep 7
# In a subshell, since writing to a closed socket can end the process with SIGPIPE.
(printf 'GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n' >&3) 2>/dev/null
reply=$(timeout 3 cat <&3 2>/dev/null)
exec 3<&-
check "an idle socket is closed before it can carry a request" test -z "$reply"

log "--- Known limit: an SSH tunnel is an established connection, so Keep still works ---"
reset_panel_host
open_held_shell || die "held shell"
ssh "${SSH_BASE[@]}" -o ControlPath=/vm/held.sock -O forward -L 9081:127.0.0.1:9080 root@127.0.0.1 || die "tunnel"
tunnel_url=http://127.0.0.1:9081/api/v1
api -X POST "$tunnel_url/reload" -d '{"confirm_timeout_seconds":60}' >/dev/null
check "new SSH connections are cut" ssh_cut
check "new connections to the panel are cut" panel_cut
check "yet Keep through the tunnel still confirms: docs and panel warn about this" test "$(api -X POST "$tunnel_url/apply/confirm" | jq -r .result)" = confirmed
held "cat >/etc/evuproxy/config.yaml" < <(write_config "$PANEL_RULES" baseline)
held evuproxy reload || die "recovery"
close_held_shell

log "=== RESULT: $failures failed ==="
if [ "$failures" -ne 0 ]; then
	vm journalctl --no-pager -n 40 -u 'evuproxy*' || true
fi
exit "$failures"
