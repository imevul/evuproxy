#!/bin/sh
# Runs after a .deb or RPM install or upgrade. Sets up /etc/evuproxy the way scripts/install.sh
# does, except for what would change the host's networking: no enabling or starting
# evuproxy.service, no nftables.service, no IP forwarding. The README has the steps it needs.
set -e

# dpkg: configure [old version]. rpm: 1 on install, 2 on upgrade.
case "${1:-}" in
configure)
	upgrade=${2:+1}
	;;
1) upgrade= ;;
2) upgrade=1 ;;
*) exit 0 ;;
esac

config_dir=/etc/evuproxy

missing() {
	[ ! -e "$1" ] && [ ! -L "$1" ]
}

new_token() {
	if missing "$1"; then
		(umask 077 && head -c 32 /dev/urandom | base64 | tr -d '\n' >"$1")
	fi
}

if missing "$config_dir"; then
	install -d -m 0755 "$config_dir"
fi
mkdir -p "$config_dir/generated" "$config_dir/geo-zones"
if missing /var/log/evuproxy; then
	install -d -m 0750 /var/log/evuproxy
fi

if missing "$config_dir/config.yaml"; then
	install -m 0644 /usr/share/evuproxy/config.example.yaml "$config_dir/config.yaml"
fi
if missing "$config_dir/wg-private.key"; then
	(umask 077 && wg genkey >"$config_dir/wg-private.key")
fi
new_token "$config_dir/api.token"
new_token "$config_dir/api-read.token"

if [ -d /run/systemd/system ]; then
	systemctl daemon-reload || true
	# Only the units that don't apply anything, and only if they run. A restart of
	# evuproxy.service would reload the firewall, so an upgrade leaves that to the admin.
	systemctl try-restart evuproxy-api.service evuproxy-metrics.service || true
fi

if [ -n "$upgrade" ]; then
	echo "evuproxy: firewall rules were left as they are. To apply this version's: evuproxy reload --config $config_dir/config.yaml"
else
	echo "evuproxy: installed. Nothing is enabled and no firewall rules changed. Edit $config_dir/config.yaml, then see \"Install from a package\" in the README."
fi
