#!/bin/bash
# The checks, as a unit under the container's systemd. Not to be run anywhere else: it installs
# units and overwrites /usr/local/bin/evuproxy.
set -uo pipefail

exec > >(tee /results/checks.log) 2>&1

[ -f /.dockerenv ] || { echo "upgrade-test: not in a container"; exit 1; }

BIN=/usr/local/bin/evuproxy
PREV=$BIN.previous
RELEASES=/srv/releases
UPGRADE=/scripts/upgrade-binary.sh
export EVUPROXY_RELEASE_URL=https://localhost:8443/releases
export CURL_CA_BUNDLE=/tmp/upgrade-test-ca.pem

failures=0
log() { echo "[$(date +%H:%M:%S)] $*"; }
pass() { log "PASS: $1"; }
fail() {
	log "FAIL: $1"
	failures=$((failures + 1))
}
check() {
	local name=$1
	shift
	if "$@"; then pass "$name"; else fail "$name"; fi
}
die() {
	log "SETUP FAILED: $*"
	echo "upgrade-test: FAILED"
	exit 1
}

# One release: makes vVERSION with BINARY as the asset and a matching SHA256SUMS.
release() {
	local version=$1 binary=$2 dir=$RELEASES/v$1 asset
	asset=evuproxy-$version-linux-$ARCH
	mkdir -p "$dir"
	cp "$binary" "$dir/$asset"
	(cd "$dir" && sha256sum "./$asset" >SHA256SUMS)
}
set_latest() { echo "$1" >"$RELEASES/latest"; }

# Everything an upgrade could touch. A refused or failed run must not change any of it.
fingerprint() {
	sha256sum "$BIN"
	if [ -e "$PREV" ]; then sha256sum "$PREV"; else echo "no previous"; fi
	sha256sum /etc/evuproxy/config.yaml
	ls -A /usr/local/bin
	local unit
	for unit in evuproxy.service evuproxy-api.service evuproxy-metrics.service; do
		systemctl show -p InvocationID -p ActiveState -p MainPID "$unit"
	done
}

# Runs the upgrade with the arguments, expecting it to fail with TEXT and change nothing.
refuses() {
	local name=$1 text=$2 before after out
	shift 2
	before=$(fingerprint)
	if out=$(env "${ENV_FOR_REFUSES[@]}" bash "$UPGRADE" "$@" 2>&1); then
		fail "$name: it exited 0"
		echo "$out"
		return
	fi
	after=$(fingerprint)
	if [ "$before" != "$after" ]; then
		fail "$name: the install changed"
		diff <(echo "$before") <(echo "$after")
	elif ! grep -qF -- "$text" <<<"$out"; then
		fail "$name: no \"$text\" in the output"
		echo "$out"
	else
		pass "$name"
	fi
}
ENV_FOR_REFUSES=(EVUPROXY_TEST=1)

version_is() { [ "$("$1" version 2>/dev/null)" = "$2" ]; }
invocation() { systemctl show -p InvocationID --value "$1"; }
main_pid() { systemctl show -p MainPID --value "$1"; }
active() { systemctl is-active --quiet "$1"; }
inactive() { ! systemctl is-active --quiet "$1"; }
runs_current_binary() {
	local pid
	pid=$(main_pid "$1")
	[ "$pid" -gt 0 ] && [ "$(readlink "/proc/$pid/exe")" = "$BIN" ]
}
differs() { [ "$1" != "$2" ]; }
same() { [ "$1" = "$2" ]; }
firewall_loaded() { nft list table ip evuproxy >/dev/null 2>&1; }

# Setup: a binary-only host running 0.0.1 under the shipped units, with a real config.
case "$(uname -m)" in
x86_64) ARCH=amd64 ;;
aarch64) ARCH=arm64 ;;
*) die "unknown architecture $(uname -m)" ;;
esac
install -m 0755 /test-bin/evuproxy-0.0.1 "$BIN" || die "install"
mkdir -p /etc/evuproxy/generated /etc/evuproxy/geo-zones /var/log/evuproxy
umask 077
wg genkey >/etc/evuproxy/wg-private.key || die "wg genkey"
head -c 32 /dev/urandom | base64 >/etc/evuproxy/api.token
umask 022
cat >/etc/evuproxy/config.yaml <<'EOF'
wireguard:
  interface: evuproxy0
  listen_port: 51830
  private_key_file: /etc/evuproxy/wg-private.key
  address: 10.100.0.1/24
network:
  public_interface: eth0
peers: []
forwarding:
  routes: []
geo:
  enabled: false
input_allows: []
apply:
  confirm: true
EOF
install -m 0644 /templates/evuproxy.service /templates/evuproxy-api.service /templates/evuproxy-metrics.service /etc/systemd/system/ || die "units"
systemctl daemon-reload
systemctl start evuproxy.service evuproxy-api.service || {
	systemctl status evuproxy.service evuproxy-api.service --no-pager
	journalctl -u evuproxy.service -u evuproxy-api.service --no-pager
	die "units did not start"
}

mkdir -p "$RELEASES"
for v in 0.0.1 0.0.2 0.0.3; do release "$v" "/test-bin/evuproxy-$v"; done
set_latest 0.0.2
/test-bin/server -dir "$RELEASES" -addr 127.0.0.1:8443 -ca "$CURL_CA_BUNDLE" &
server=$!
trap 'kill "$server" 2>/dev/null' EXIT
for _ in $(seq 50); do
	[ -s "$CURL_CA_BUNDLE" ] && curl -fsS -o /dev/null https://localhost:8443/releases/latest && break
	sleep 0.1
done
curl -fsS -o /dev/null https://localhost:8443/releases/latest || die "server did not start"

log "--- failed downloads and bad releases leave the install untouched"

check "starts on 0.0.1" version_is "$BIN" 0.0.1

release 0.1.1 /test-bin/evuproxy-0.0.2
rm "$RELEASES/v0.1.1/evuproxy-0.1.1-linux-$ARCH"
refuses "the binary answers 404" "couldn't download" --version 0.1.1

release 0.1.2 /test-bin/evuproxy-0.0.2
rm "$RELEASES/v0.1.2/SHA256SUMS"
refuses "SHA256SUMS answers 404" "couldn't download" --version 0.1.2

release 0.1.3 /test-bin/evuproxy-0.0.2
touch "$RELEASES/v0.1.3/evuproxy-0.1.3-linux-$ARCH.truncate"
refuses "the download is cut off halfway" "couldn't download" --version 0.1.3

refuses "the version doesn't exist" "couldn't download" --version 9.9.9

ENV_FOR_REFUSES=(EVUPROXY_RELEASE_URL=https://localhost:1/releases)
refuses "nothing is listening" "couldn't download" --version 0.0.2
refuses "nothing is listening for latest" "couldn't find the latest release"
ENV_FOR_REFUSES=(EVUPROXY_TEST=1)

ENV_FOR_REFUSES=(CURL_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt)
refuses "the certificate isn't trusted" "couldn't download" --version 0.0.2
ENV_FOR_REFUSES=(EVUPROXY_RELEASE_URL=http://localhost:8443/releases)
refuses "a plain http URL" "must start with https://" --version 0.0.2
ENV_FOR_REFUSES=(EVUPROXY_TEST=1)

release 0.1.4 /test-bin/evuproxy-0.0.2
echo "corrupted" >>"$RELEASES/v0.1.4/evuproxy-0.1.4-linux-$ARCH"
refuses "the checksum doesn't match" "checksum mismatch" --version 0.1.4

release 0.1.5 /test-bin/evuproxy-0.0.2
echo "0000  ./something-else" >"$RELEASES/v0.1.5/SHA256SUMS"
refuses "SHA256SUMS doesn't list the binary" "no entry" --version 0.1.5

release 0.1.6 /test-bin/evuproxy-0.0.2
refuses "the binary reports another version" "reports version" --version 0.1.6

head -c 4096 /dev/urandom >/tmp/garbage
release 0.1.7 /tmp/garbage
refuses "the binary doesn't run" "reports version" --version 0.1.7

printf 'not a version\n' >"$RELEASES/latest"
refuses "latest isn't a version" "couldn't read a version"
set_latest 0.0.2

refuses "an unusable --version" "not a version" --version 'x;y'

log "--- refusals before the swap"

cat >/tmp/rejects-config <<'EOF'
#!/bin/sh
case "$1" in
version) echo 0.1.8 ;;
validate)
	[ "$2" = --help ] && exit 0
	echo "config: stricter than before" >&2
	exit 1
	;;
reload) echo "--boot" ;;
esac
EOF
chmod +x /tmp/rejects-config
release 0.1.8 /tmp/rejects-config
refuses "the release rejects config.yaml" "rejects" --version 0.1.8

cat >/tmp/no-boot <<'EOF'
#!/bin/sh
case "$1" in
version) echo 0.1.9 ;;
esac
EOF
chmod +x /tmp/no-boot
release 0.1.9 /tmp/no-boot
refuses "a release without --boot under a unit with it" "reload --boot" --version 0.1.9

"$BIN" reload --confirm-within 300s --config /etc/evuproxy/config.yaml >/dev/null || die "open a confirm window"
refuses "a confirm window is open" "waiting for confirmation" --version 0.0.2
"$BIN" reload-revert --config /etc/evuproxy/config.yaml >/dev/null || die "close the confirm window"

refuses "--rollback with nothing to go back to" "nothing to roll back to" --rollback

log "--- upgrade"

check "the metrics unit starts inactive" inactive evuproxy-metrics.service
boot_before=$(invocation evuproxy.service)
api_before=$(invocation evuproxy-api.service)
config_before=$(sha256sum /etc/evuproxy/config.yaml)
if out=$(bash "$UPGRADE" 2>&1); then pass "upgrades to the latest release"; else fail "upgrades to the latest release"; fi
echo "$out"
check "the binary is 0.0.2" version_is "$BIN" 0.0.2
check "it is mode 0755" [ "$(stat -c %a "$BIN")" = 755 ]
check "the old binary is kept" version_is "$PREV" 0.0.1
check "evuproxy.service ran again" differs "$boot_before" "$(invocation evuproxy.service)"
check "evuproxy.service is active" active evuproxy.service
check "the firewall is loaded" firewall_loaded
check "the API restarted" differs "$api_before" "$(invocation evuproxy-api.service)"
check "the API runs the new binary" runs_current_binary evuproxy-api.service
check "an inactive service stays inactive" inactive evuproxy-metrics.service
check "config.yaml is unchanged" same "$config_before" "$(sha256sum /etc/evuproxy/config.yaml)"
check "no temporary directory is left" same "" "$(find /usr/local/bin -name '.evuproxy-upgrade.*')"

log "--- already current"

before=$(fingerprint)
out=$(bash "$UPGRADE" 2>&1)
check "the same version exits 0" [ $? -eq 0 ]
check "the same version says so" grep -qF "already 0.0.2" <<<"$out"
check "the same version changes nothing" same "$before" "$(fingerprint)"
set_latest 0.0.1
out=$(bash "$UPGRADE" 2>&1)
check "an older latest isn't installed" grep -qF "newer than the latest" <<<"$out"
check "an older latest changes nothing" same "$before" "$(fingerprint)"
set_latest 0.0.2

log "--- rollback"

api_before=$(invocation evuproxy-api.service)
if out=$(bash "$UPGRADE" --rollback 2>&1); then pass "rolls back"; else fail "rolls back"; fi
echo "$out"
check "the binary is 0.0.1" version_is "$BIN" 0.0.1
check "the rolled-back binary is kept" version_is "$PREV" 0.0.2
check "the API restarted on rollback" differs "$api_before" "$(invocation evuproxy-api.service)"
check "the API runs the old binary" runs_current_binary evuproxy-api.service
bash "$UPGRADE" --rollback >/dev/null 2>&1
check "a second rollback goes forward again" version_is "$BIN" 0.0.2

log "--- --version"

if out=$(bash "$UPGRADE" --version v0.0.3 2>&1); then pass "--version with a v"; else fail "--version with a v"; fi
check "the binary is 0.0.3" version_is "$BIN" 0.0.3
check "only one old binary is kept" version_is "$PREV" 0.0.2
bash "$UPGRADE" --version 0.0.1 >/dev/null 2>&1
check "--version goes back too" version_is "$BIN" 0.0.1
bash "$UPGRADE" --version 0.0.2 >/dev/null 2>&1
check "and forward again" version_is "$BIN" 0.0.2

log "--- a service that fails after the swap"

mkdir -p /etc/systemd/system/evuproxy-api.service.d
printf '[Service]\nExecStartPre=/bin/false\n' >/etc/systemd/system/evuproxy-api.service.d/fail.conf
systemctl daemon-reload
boot_before=$(invocation evuproxy.service)
if out=$(bash "$UPGRADE" --version 0.0.3 2>&1); then
	fail "a failed restart exits non-zero"
else
	pass "a failed restart exits non-zero"
fi
check "it names the service" grep -qF "failed: evuproxy-api.service" <<<"$out"
check "it says how to go back" grep -qF -- "--rollback" <<<"$out"
check "the other service still restarted" differs "$boot_before" "$(invocation evuproxy.service)"
rm -r /etc/systemd/system/evuproxy-api.service.d
systemctl daemon-reload
systemctl reset-failed evuproxy-api.service
systemctl start evuproxy-api.service
if bash "$UPGRADE" --rollback >/dev/null 2>&1; then pass "rollback recovers it"; else fail "rollback recovers it"; fi
check "the API is back" active evuproxy-api.service

log "--- a unit from before --boot"

mkdir -p /etc/systemd/system/evuproxy.service.d
printf '[Service]\nExecStart=\nExecStart=%s reload --config /etc/evuproxy/config.yaml\n' "$BIN" >/etc/systemd/system/evuproxy.service.d/old.conf
systemctl daemon-reload
systemctl restart evuproxy.service
boot_before=$(invocation evuproxy.service)
api_before=$(invocation evuproxy-api.service)
target_version=0.0.3
[ "$("$BIN" version)" = 0.0.3 ] && target_version=0.0.2
out=$(bash "$UPGRADE" --version "$target_version" 2>&1)
check "it exits 0" [ $? -eq 0 ]
check "it warns" grep -qF "evuproxy.service has no --boot" <<<"$out"
check "evuproxy.service isn't restarted, so unconfirmed edits stay unapplied" same "$boot_before" "$(invocation evuproxy.service)"
check "the API still restarted" differs "$api_before" "$(invocation evuproxy-api.service)"
rm -r /etc/systemd/system/evuproxy.service.d
systemctl daemon-reload
systemctl restart evuproxy.service

log "--- another PREFIX, and no systemctl"

mkdir -p /opt/evu/bin
install -m 0755 /test-bin/evuproxy-0.0.1 /opt/evu/bin/evuproxy
boot_before=$(invocation evuproxy.service)
out=$(PREFIX=/opt/evu bash "$UPGRADE" 2>&1)
check "PREFIX: it exits 0" [ $? -eq 0 ]
check "PREFIX: the binary there is upgraded" version_is /opt/evu/bin/evuproxy 0.0.2
check "PREFIX: units running another binary are left alone" same "$boot_before" "$(invocation evuproxy.service)"
check "PREFIX: it warns about them" grep -qF "runs a different binary" <<<"$out"

mkdir /tmp/nosystemd
for tool in bash cat chmod cp curl cut env grep id mktemp mv rm sha256sum sleep sort tail uname awk readlink nft ip wg; do
	ln -s "$(command -v "$tool")" "/tmp/nosystemd/$tool" || die "no $tool"
done
install -m 0755 /test-bin/evuproxy-0.0.1 /opt/evu/bin/evuproxy
rm -f /opt/evu/bin/evuproxy.previous
out=$(PATH=/tmp/nosystemd PREFIX=/opt/evu /tmp/nosystemd/bash "$UPGRADE" 2>&1)
check "no systemctl: it exits 0" [ $? -eq 0 ]
check "no systemctl: the binary is upgraded" version_is /opt/evu/bin/evuproxy 0.0.2
check "no systemctl: it says to restart by hand" grep -qF "No systemctl here" <<<"$out"

log "--- not an install"

refuses_missing=$(PREFIX=/nonexistent bash "$UPGRADE" 2>&1)
check "no binary at PREFIX is refused" [ $? -ne 0 ]
check "it says what to do" grep -qF "no binary at /nonexistent/bin/evuproxy" <<<"$refuses_missing"

log "--- uninstall"

bash /scripts/uninstall.sh >/dev/null 2>&1
check "uninstall removes the kept binary" [ ! -e "$PREV" ]

if [ "$failures" -gt 0 ]; then
	log "$failures check(s) failed"
	echo "upgrade-test: FAILED"
	exit 1
fi
echo "upgrade-test: passed"
