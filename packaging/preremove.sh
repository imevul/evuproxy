#!/bin/sh
# Runs before a .deb or RPM is removed or upgraded. Stops and disables the units on removal.
# Stopping evuproxy.service leaves the firewall as it is, as scripts/uninstall.sh does.

# dpkg: remove, or upgrade and others. rpm: 0 on removal, 1 on upgrade.
case "${1:-}" in
remove | 0) ;;
*) exit 0 ;;
esac

for unit in evuproxy-api.service evuproxy-metrics.service evuproxy.service evuproxy-geo.service evuproxy-geo.timer; do
	if [ -d /run/systemd/system ]; then
		systemctl stop "$unit" 2>/dev/null || true
	fi
	systemctl disable "$unit" 2>/dev/null || true
done

exit 0
