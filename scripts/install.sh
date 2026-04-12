#!/usr/bin/env bash
set -euo pipefail

# EvuProxy install — idempotent baseline for a VPS.
# Run as root. From repo: ./scripts/install.sh
# Optional: EVUPROXY_SRC=/path/to/repo to build the binary with Go.

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

mkdir -p "$CONFIG_DIR/generated" "$CONFIG_DIR/geo-zones"
chmod 755 "$CONFIG_DIR"

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

systemctl daemon-reload
systemctl enable nftables.service 2>/dev/null || true
systemctl enable evuproxy.service evuproxy-api.service evuproxy-geo.timer 2>/dev/null || true

echo "Installed EvuProxy tooling."
echo "Edit $CONFIG_DIR/config.yaml, add peer keys, then: evuproxy reload --config $CONFIG_DIR/config.yaml"
echo "API (optional): systemctl start evuproxy-api.service (token in $CONFIG_DIR/api.token)"
