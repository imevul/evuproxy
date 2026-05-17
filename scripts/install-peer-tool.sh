#!/usr/bin/env bash
set -euo pipefail
# EvuProxy — install evuproxy-peer-apply CLI (downloads the bundle decrypt + WireGuard onboarding script).
#
# Typical: curl -fsSL <this-url> | sudo bash
#
# Overrides:
#   EVUPROXY_PEER_APPLY_DOWNLOAD_URL   URL of evuproxy-peer-bundle-apply.sh (default tracks main branch)
#   EVUPREFIX                          Install directory (default /usr/local/bin)
#
# Default uses GitHub `main`: hard-coded tag URLs drift stale unless bumped every release. `main` is a moving branch — for audited
# installs set EVUPROXY_PEER_APPLY_DOWNLOAD_URL (and related overrides) to a tag-pinned raw URL with checksum discipline.

DEFAULT_APPLY_SH_URL="https://raw.githubusercontent.com/imevul/evuproxy/main/scripts/evuproxy-peer-bundle-apply.sh"
URL="${EVUPROXY_PEER_APPLY_DOWNLOAD_URL:-$DEFAULT_APPLY_SH_URL}"

case "${URL}" in
https://*) ;;
*)
  printf '%s\n' "install-peer-tool.sh: download URL must start with https://" >&2
  exit 1
  ;;
esac
PREFIX="${EVUPREFIX:-/usr/local/bin}"
TARGET="$PREFIX/evuproxy-peer-apply"

if [[ "$(id -u)" -ne 0 ]]; then
  printf '%s\n' "install-peer-tool.sh: run as root (example: curl -fsSL …/install-peer-tool.sh | sudo bash)" >&2
  exit 1
fi

have() { command -v "$1" >/dev/null 2>&1; }
have curl || {
  printf '%s\n' "install-peer-tool.sh: curl is required." >&2
  exit 1
}

mkdir -p "$PREFIX"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl --proto '=https' --proto-redir '=https' -fsSL "$URL" -o "$tmp"
install -m 0755 "$tmp" "$TARGET"
printf '%s\n' "Installed $TARGET"
