#!/usr/bin/env bash
set -euo pipefail

# EvuProxy install — idempotent baseline for a VPS.
# Run as root. From repo: ./scripts/install.sh
# Optional: EVUPROXY_SRC=/path/to/repo to build the binary with Go.
# Optional: EVUPROXY_INSTALL_API — if set, controls whether evuproxy-api.service is
#   enabled (0 / false / no / off = disabled; anything else = enabled). When unset,
#   an interactive TTY gets a prompt; non-interactive default is enable. See docs/http-api.md.

PREFIX="${PREFIX:-/usr/local}"
CONFIG_DIR="${CONFIG_DIR:-/etc/evuproxy}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root." >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard nftables curl iproute2
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y wireguard-tools nftables curl iproute
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm wireguard-tools nftables curl iproute2
else
  echo "Install wireguard-tools, nftables, curl, iproute2 using your distro package manager." >&2
  exit 1
fi

mkdir -p "$CONFIG_DIR/generated" "$CONFIG_DIR/geo-zones" /var/log/evuproxy
chmod 755 "$CONFIG_DIR"
chmod 750 /var/log/evuproxy

sysctl -w net.ipv4.ip_forward=1 >/dev/null
cat >/etc/sysctl.d/99-evuproxy-forwarding.conf <<'EOF'
net.ipv4.ip_forward = 1
EOF

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -n "${EVUPROXY_SRC:-}" ]]; then
  REPO_ROOT="$EVUPROXY_SRC"
fi

if [[ -f "$REPO_ROOT/go.mod" ]] && command -v go >/dev/null 2>&1; then
  echo "Building evuproxy from $REPO_ROOT ..."
  (cd "$REPO_ROOT" && go build -ldflags "-X main.version=0.1.0" -o /tmp/evuproxy ./cmd/evuproxy)
  install -m 0755 /tmp/evuproxy "$PREFIX/bin/evuproxy"
else
  echo "No Go toolchain or go.mod; place evuproxy binary at $PREFIX/bin/evuproxy manually." >&2
fi

if [[ ! -f "$CONFIG_DIR/config.yaml" ]]; then
  install -m 0644 "$REPO_ROOT/config/evuproxy.example.yaml" "$CONFIG_DIR/config.yaml"
fi

if [[ ! -f "$CONFIG_DIR/wg-private.key" ]]; then
  umask 077
  wg genkey | tee "$CONFIG_DIR/wg-private.key" >/dev/null
  chmod 600 "$CONFIG_DIR/wg-private.key"
fi

if [[ ! -f "$CONFIG_DIR/api.token" ]]; then
  umask 077
  head -c 32 /dev/urandom | base64 | tr -d '\n' >"$CONFIG_DIR/api.token"
  chmod 600 "$CONFIG_DIR/api.token"
fi

for unit in evuproxy.service evuproxy-geo.service evuproxy-geo.timer evuproxy-api.service; do
  install -m 0644 "$REPO_ROOT/templates/$unit" "/etc/systemd/system/$unit"
done

if [[ -n "${EVUPROXY_INSTALL_API+set}" ]]; then
  _api_lc="$(printf '%s' "${EVUPROXY_INSTALL_API}" | tr '[:upper:]' '[:lower:]')"
  case "$_api_lc" in
  0 | false | no | off) INSTALL_API=0 ;;
  *) INSTALL_API=1 ;;
  esac
elif [[ -t 0 ]]; then
  read -r -p "Enable local HTTP API at boot (127.0.0.1:9847)? The unit file is always installed. [Y/n] " reply || true
  _r_lc="$(printf '%s' "${reply:-y}" | tr '[:upper:]' '[:lower:]')"
  case "$_r_lc" in
  y | yes) INSTALL_API=1 ;;
  n | no) INSTALL_API=0 ;;
  *) INSTALL_API=1 ;;
  esac
else
  INSTALL_API=1
fi

systemctl daemon-reload
systemctl enable nftables.service 2>/dev/null || true
systemctl enable evuproxy.service evuproxy-geo.timer 2>/dev/null || true
if [[ "$INSTALL_API" -eq 1 ]]; then
  systemctl enable evuproxy-api.service 2>/dev/null || true
fi

echo "Installed EvuProxy tooling."
echo "Edit $CONFIG_DIR/config.yaml, add peer keys, then: evuproxy reload --config $CONFIG_DIR/config.yaml"
if [[ "$INSTALL_API" -eq 1 ]]; then
  echo "HTTP API: enabled at boot (token in $CONFIG_DIR/api.token). Start now: systemctl start evuproxy-api.service"
else
  echo "HTTP API: unit installed but not enabled. Enable later: systemctl enable --now evuproxy-api.service (token in $CONFIG_DIR/api.token; see docs/http-api.md)"
fi
