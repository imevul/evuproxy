#!/usr/bin/env bash
set -euo pipefail

# EvuProxy uninstall — stops units and removes packaged files.
# Retained by default (not deleted):
#   - /etc/evuproxy/ (config, keys, geo zones, generated snippets)
#   - /etc/wireguard/*.conf if you applied them
#   - Docker volumes for the web UI (if used)
# Use PURGE=1 to remove /etc/evuproxy (destructive).

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

systemctl stop evuproxy-api.service 2>/dev/null || true
systemctl stop evuproxy.service 2>/dev/null || true
systemctl stop evuproxy-geo.service 2>/dev/null || true
systemctl stop evuproxy-geo.timer 2>/dev/null || true
systemctl disable evuproxy-api.service 2>/dev/null || true
systemctl disable evuproxy.service 2>/dev/null || true
systemctl disable evuproxy-geo.service 2>/dev/null || true
systemctl disable evuproxy-geo.timer 2>/dev/null || true

rm -f /etc/systemd/system/evuproxy.service \
 /etc/systemd/system/evuproxy-api.service \
 /etc/systemd/system/evuproxy-geo.service \
 /etc/systemd/system/evuproxy-geo.timer
systemctl daemon-reload

rm -f /usr/local/bin/evuproxy

rm -f /etc/sysctl.d/99-evuproxy-forwarding.conf

if [[ "${PURGE:-0}" == "1" ]]; then
  rm -rf /etc/evuproxy
  echo "Removed /etc/evuproxy (purge)."
else
  echo "Left /etc/evuproxy in place; set PURGE=1 to delete."
fi

echo "Uninstall complete. Review WireGuard configs under /etc/wireguard if interfaces remain."
