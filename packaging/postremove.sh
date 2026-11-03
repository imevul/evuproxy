#!/bin/sh
# Runs after a .deb or RPM is removed or upgraded. Removal does what scripts/uninstall.sh does and
# keeps /etc/evuproxy. Only a dpkg purge deletes that, like PURGE=1; rpm has no purge.

# dpkg: remove, purge, or upgrade and others. rpm: 0 on removal, 1 on upgrade.
case "${1:-}" in
remove | 0)
	# The same drop-ins as scripts/uninstall.sh, written by the evuproxy reload the admin ran.
	wg_iface=evuproxy0
	if [ -r /etc/evuproxy/config.yaml ] && command -v awk >/dev/null 2>&1; then
		from_cfg="$(awk '
			/^[[:space:]]*wireguard:[[:space:]]*$/ { in_wg=1; next }
			in_wg && /^[^[:space:]#]/ { in_wg=0 }
			in_wg && /^[[:space:]]*interface:[[:space:]]*/ {
				sub(/^[[:space:]]*interface:[[:space:]]*/, ""); gsub(/["\047]/, ""); print; exit
			}
		' /etc/evuproxy/config.yaml)" || true
		if [ -n "$from_cfg" ]; then
			wg_iface=$from_cfg
		fi
	fi
	rm -f "/etc/systemd/network/00-$wg_iface.network" "/etc/systemd/network/80-$wg_iface.network"
	rm -f /etc/systemd/network/00-evuproxy0.network /etc/systemd/network/80-evuproxy0.network
	rm -f /etc/sysctl.d/99-evuproxy-forwarding.conf
	if [ -d /run/systemd/system ]; then
		systemctl daemon-reload || true
	fi
	;;
purge)
	rm -rf /etc/evuproxy /var/log/evuproxy
	;;
esac

exit 0
