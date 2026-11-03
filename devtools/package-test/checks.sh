#!/bin/bash
# Runs under systemd in the container from entry.sh, with stdin closed, so a package that stops to
# ask something fails. Changes firewall rules, so it refuses outside that container.
set -uo pipefail

exec >/results/checks.log 2>&1

[ "${container:-}" = docker ] || systemd-detect-virt --container --quiet || { echo "package-test: not in a container"; exit 1; }

units=(evuproxy.service evuproxy-api.service evuproxy-geo.service evuproxy-geo.timer evuproxy-metrics.service)
secrets=(wg-private.key api.token api-read.token)
config=/etc/evuproxy/config.yaml
failures=0

check() {
	local what=$1
	shift
	if "$@"; then
		echo "ok    $what"
	else
		echo "FAIL  $what"
		failures=$((failures + 1))
	fi
}

die() {
	echo "FAIL  $*"
	exit 1
}

if command -v dpkg >/dev/null; then
	export DEBIAN_FRONTEND=noninteractive
	new_package() { echo "/pkg/evuproxy_$1_"*.deb; }
	pm() { timeout 300 apt-get "$@" -y; }
	# Dependencies were never installed, so the first install needs the package lists.
	timeout 300 apt-get update -qq || die "apt-get update"
	package_absent() { [ "$(dpkg-query -W -f '${db:Status-Status}' evuproxy 2>/dev/null)" != installed ]; }
	state_is_clean() { [ -z "$(dpkg --audit)" ]; }
else
	new_package() { echo "/pkg/evuproxy-$1-1."*.rpm; }
	# Without the setopt, dnf remove takes nftables along, and the checks after it need nft.
	pm() { timeout 300 dnf "$@" -y --setopt=clean_requirements_on_remove=False; }
	package_absent() { ! rpm -q evuproxy >/dev/null; }
	state_is_clean() { rpm -q evuproxy >/dev/null && rpm -V evuproxy; }
fi

# Runs the package manager and rejects maintainer script trouble it would only warn about.
pm_clean() {
	local out
	out=$(pm "$@" 2>&1)
	local status=$?
	echo "$out" >>/results/package-manager.log
	[ "$status" -eq 0 ] || { echo "$out"; return 1; }
	case $out in
	*"scriptlet failed"* | *"dpkg: warning"* | *"dpkg: error"*)
		echo "$out"
		return 1
		;;
	esac
}

install_version() {
	pm_clean install "$(new_package "$1")"
}

running_version_is() {
	[[ "$(evuproxy version)" == *"$1"* ]]
}

no_firewall_changes() {
	local ruleset
	ruleset=$(nft list ruleset) || return 1
	[[ "$ruleset" != *evuproxy* ]]
}

network_untouched() {
	[ "$(cat /proc/sys/net/ipv4/ip_forward)" = 0 ] &&
		[ ! -e /sys/class/net/evuproxy0 ] &&
		[ ! -e /etc/wireguard/evuproxy0.conf ] &&
		[ ! -e /etc/sysctl.d/99-evuproxy-forwarding.conf ] &&
		[ ! -e /etc/systemd/network/00-evuproxy0.network ]
}

all_disabled_and_stopped() {
	local unit
	for unit in "${units[@]}"; do
		[ "$(systemctl is-enabled "$unit" 2>&1)" = disabled ] || { echo "$unit is enabled"; return 1; }
		[ "$(systemctl is-active "$unit" 2>&1)" != active ] || { echo "$unit is active"; return 1; }
	done
}

units_run_packaged_binary() {
	local unit
	for unit in evuproxy.service evuproxy-api.service evuproxy-geo.service evuproxy-metrics.service; do
		[[ "$(<"/usr/lib/systemd/system/$unit")" == *ExecStart=/usr/bin/evuproxy* ]] || { echo "$unit"; return 1; }
	done
}

secrets_generated() {
	local name
	for name in "${secrets[@]}"; do
		[ -s "/etc/evuproxy/$name" ] && [ "$(stat -c %a "/etc/evuproxy/$name")" = 600 ] || { echo "$name"; return 1; }
	done
}

state_sums() {
	(cd /etc/evuproxy && sha256sum config.yaml "${secrets[@]}")
}

api_answers() {
	local i
	for i in $(seq 1 50); do
		if (exec 3<>/dev/tcp/127.0.0.1/9847) 2>/dev/null; then
			return 0
		fi
		sleep 0.2
	done
	return 1
}

api_pid() {
	systemctl show -p MainPID --value evuproxy-api.service
}

no_package_manager_leftovers() {
	[ -z "$(find /etc/evuproxy -name '*.dpkg-*' -o -name '*.rpmnew' -o -name '*.rpmsave' -o -name '*.rpmorig')" ]
}

packaged_files_gone() {
	local left
	left=$(find /usr/bin/evuproxy /usr/share/evuproxy /usr/share/doc/evuproxy 2>/dev/null
		find /usr/lib/systemd/system /etc/systemd/system -name 'evuproxy*')
	[ -z "$left" ] || { echo "$left"; return 1; }
}

same_file() {
	[ "$(sha256sum <"$1")" = "$(sha256sum <"$2")" ]
}

rules_loaded() {
	nft list table inet evuproxy >/dev/null
}

# A host can confine /usr/bin/wg-quick by path, and that reaches into a privileged container. Seen
# on Ubuntu 26.04, where it runs /usr/bin/ip but not AlmaLinux's /usr/sbin/ip. wg-quick looks in
# its own directory first, so a copy there gets past a limit that belongs to the host, not the
# package. The note says when this happened.
work_around_host_wg_quick_confinement() {
	local out
	mkdir -p /etc/wireguard
	printf '[Interface]\nPrivateKey = %s\n' "$(wg genkey)" >/etc/wireguard/pkgprobe.conf
	chmod 600 /etc/wireguard/pkgprobe.conf
	out=$(wg-quick up pkgprobe 2>&1)
	ip link delete pkgprobe 2>/dev/null
	rm -f /etc/wireguard/pkgprobe.conf
	if [[ "$out" == *"Permission denied"* ]] && [ ! -e /usr/bin/ip ]; then
		echo "note: this host confines wg-quick; copying ip to /usr/bin for the rest of this run"
		install -m 0755 "$(command -v ip)" /usr/bin/ip
	fi
}

# Nothing here turns forwarding on, so any change to it comes from the package.
echo 0 >/proc/sys/net/ipv4/ip_forward || die "set ip_forward"

echo "--- fresh install"
check "installs, with dependencies, without asking" install_version 0.0.1 || true
command -v evuproxy >/dev/null || die "evuproxy was not installed"
check "binary is 0.0.1" running_version_is 0.0.1
check "units run /usr/bin/evuproxy" units_run_packaged_binary
check "config seeded from the example" same_file "$config" /usr/share/evuproxy/config.example.yaml
check "keys and tokens generated, mode 600" secrets_generated
check "seed config validates" evuproxy validate --config "$config"
check "no unit enabled or started" all_disabled_and_stopped
check "nftables.service not enabled" test "$(systemctl is-enabled nftables.service 2>&1)" != enabled
check "no firewall rules" no_firewall_changes
check "forwarding, tunnel and drop-ins untouched" network_untouched
check "package state is clean" state_is_clean

echo "--- units work once the admin enables them"
check "API starts from the packaged unit" systemctl start evuproxy-api.service
check "API answers" api_answers
check "starting the API added no firewall rules" no_firewall_changes

echo "--- upgrade over a live setup"
echo "# changed by the admin" >>"$config"
nft add table inet evuproxy && nft add chain inet evuproxy marker || die "add marker rules"
# Counts restarts of evuproxy.service, which would reload the firewall.
mkdir -p /etc/systemd/system/evuproxy.service.d
cat >/etc/systemd/system/evuproxy.service.d/test.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/bin/sh -c 'echo started >>/run/evuproxy-starts'
EOF
systemctl daemon-reload
systemctl enable -q --now evuproxy.service || die "start evuproxy.service"
systemctl enable -q evuproxy-geo.timer || die "enable evuproxy-geo.timer"
# If it was already running, the count below would mean nothing.
check "evuproxy.service started once before the upgrade" test "$(wc -l </run/evuproxy-starts)" -eq 1
sums_before=$(state_sums)
rules_before=$(nft list ruleset)
pid_before=$(api_pid)

check "upgrades to 0.0.2" install_version 0.0.2
check "binary is 0.0.2" running_version_is 0.0.2
check "config and secrets unchanged" test "$(state_sums)" = "$sums_before"
check "no config conflict files" no_package_manager_leftovers
check "firewall rules unchanged" test "$(nft list ruleset)" = "$rules_before"
check "forwarding, tunnel and drop-ins untouched" network_untouched
check "evuproxy.service not restarted" test "$(wc -l </run/evuproxy-starts)" -eq 1
check "evuproxy.service still enabled" systemctl is-enabled -q evuproxy.service
check "evuproxy-geo.timer still enabled" systemctl is-enabled -q evuproxy-geo.timer
check "API restarted on the new binary" test "$(api_pid)" != "$pid_before"
check "API answers after the upgrade" api_answers
check "package state is clean" state_is_clean

echo "--- remove"
# As an admin would have left them, following the README.
mkdir -p /etc/sysctl.d /etc/systemd/network
echo "net.ipv4.ip_forward = 1" >/etc/sysctl.d/99-evuproxy-forwarding.conf
: >/etc/systemd/network/00-evuproxy0.network
rm -rf /etc/systemd/system/evuproxy.service.d
systemctl daemon-reload
check "removes" pm_clean remove evuproxy
systemctl daemon-reload
check "package is gone" package_absent
check "binary, units and seed gone" packaged_files_gone
check "API stopped" test "$(systemctl is-active evuproxy-api.service 2>&1)" != active
check "config and secrets kept" test "$(state_sums)" = "$sums_before"
check "firewall rules left as they were" test "$(nft list ruleset)" = "$rules_before"
check "sysctl and networkd drop-ins removed" network_untouched

echo "--- reinstall keeps the config"
check "reinstalls" install_version 0.0.2
check "config and secrets unchanged" test "$(state_sums)" = "$sums_before"
check "no unit enabled or started" all_disabled_and_stopped
check "removes again" pm_clean remove evuproxy

echo "--- purge"
if command -v dpkg >/dev/null; then
	check "purges" pm_clean purge evuproxy
	check "/etc/evuproxy and logs gone" test ! -e /etc/evuproxy -a ! -e /var/log/evuproxy
	check "package state is clean" test -z "$(dpkg --audit)"
else
	echo "rpm has no purge; deleting /etc/evuproxy by hand"
	rm -rf /etc/evuproxy
fi

echo "--- first install on a host that already has a config"
mkdir -p /etc/evuproxy
echo "# written before the package" >"$config"
sums_before=$(sha256sum "$config")
check "installs without asking" install_version 0.0.1
check "existing config not overwritten" test "$(sha256sum "$config")" = "$sums_before"
check "no config conflict files" no_package_manager_leftovers
check "removes" pm_clean remove evuproxy
check "existing config kept" test "$(sha256sum "$config")" = "$sums_before"

echo "--- the README's setup steps, for real"
nft delete table inet evuproxy || die "delete marker rules"
rm -rf /etc/evuproxy
check "installs" install_version 0.0.2
work_around_host_wg_quick_confinement
# The README uses sysctl, which minimal images don't have.
echo 1 >/proc/sys/net/ipv4/ip_forward || die "turn on forwarding"
check "evuproxy reload applies the seed config" evuproxy reload --config "$config"
check "rules are loaded" rules_loaded
check "tunnel is up" test -e /sys/class/net/evuproxy0
check "units enable" systemctl enable -q nftables.service evuproxy.service evuproxy-geo.timer
check "evuproxy.service applies from the packaged unit" systemctl start evuproxy.service
check "API enables and starts" systemctl enable -q --now evuproxy-api.service
check "API answers" api_answers
rules_before=$(nft list ruleset)
check "removes" pm_clean remove evuproxy
check "removal leaves the rules" test "$(nft list ruleset)" = "$rules_before"

if [ "$failures" -gt 0 ]; then
	echo "package-test: $failures check(s) failed"
	exit 1
fi
echo "package-test: passed"
