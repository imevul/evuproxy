#!/usr/bin/env bash
set -euo pipefail

# EvuProxy — WireGuard client (peer) setup for Linux.
# Run as root. Installs wireguard-tools, writes /etc/wireguard/<iface>.conf, enables wg-quick.
#
# Example (the admin UI generates a script that downloads this file, prints sha256sum for
# comparison with GitHub Release SHA256SUMS, then runs: sudo -E bash "$tmpfile").
# Avoid copying a raw `curl … | bash` one-liner from old docs unless you verify the script hash first.
#
# Pin a release by replacing `main` with a tag or commit in the URL.
#
# Security: the command embeds your private key (shell history, shared sessions). Only use on a
# trusted peer. Verify the script (checksum or review) before execution; host your own copy for stricter control.

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root (e.g. sudo -E bash)." >&2
  exit 1
fi

: "${EVUPROXY_WG_PRIVATE_KEY:?Set EVUPROXY_WG_PRIVATE_KEY}"
: "${EVUPROXY_WG_ADDRESS:?Set EVUPROXY_WG_ADDRESS (e.g. 10.100.0.5/32)}"
: "${EVUPROXY_WG_SERVER_PUBLIC_KEY:?Set EVUPROXY_WG_SERVER_PUBLIC_KEY}"
: "${EVUPROXY_WG_ENDPOINT:?Set EVUPROXY_WG_ENDPOINT (host:port)}"
: "${EVUPROXY_WG_ALLOWED_IPS:?Set EVUPROXY_WG_ALLOWED_IPS (tunnel subnet CIDR)}"

iface="${EVUPROXY_WG_INTERFACE:-evuproxy}"
if [[ ! "$iface" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "EVUPROXY_WG_INTERFACE must be alphanumeric, hyphen, or underscore only." >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard-tools
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y wireguard-tools
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm wireguard-tools
else
  echo "Install wireguard-tools with your distro package manager, then re-run this script." >&2
  exit 1
fi

mkdir -p /etc/wireguard
chmod 755 /etc/wireguard

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

{
  echo "[Interface]"
  echo "PrivateKey = ${EVUPROXY_WG_PRIVATE_KEY}"
  echo "Address = ${EVUPROXY_WG_ADDRESS}"
  echo ""
  echo "[Peer]"
  echo "PublicKey = ${EVUPROXY_WG_SERVER_PUBLIC_KEY}"
  echo "Endpoint = ${EVUPROXY_WG_ENDPOINT}"
  echo "AllowedIPs = ${EVUPROXY_WG_ALLOWED_IPS}"
  echo "PersistentKeepalive = 25"
} >"$tmp"

install -m 0600 "$tmp" "/etc/wireguard/${iface}.conf"

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now "wg-quick@${iface}.service"
  echo "WireGuard enabled: wg-quick@${iface}.service"
else
  wg-quick up "$iface"
  echo "WireGuard brought up with wg-quick (no systemd)."
fi
