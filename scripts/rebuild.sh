#!/usr/bin/env bash
set -euo pipefail

# Build EvuProxy from this repository (requires Go 1.25+ on PATH).
# Usage:
#   ./scripts/rebuild.sh              # writes ./evuproxy in repo root
#   sudo ./scripts/rebuild.sh --install   # build, install to PREFIX/bin, refresh an unmodified evuproxy.service
#
# Optional env:
#   PREFIX   default /usr/local (used with --install)
#   OUT      output filename, default evuproxy (under repo root)
#   UNIT_DIR default /etc/systemd/system (used with --install)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

OUT="${OUT:-evuproxy}"
PREFIX="${PREFIX:-/usr/local}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
VERSION="$(git -C "$REPO_ROOT" describe --tags --always 2>/dev/null || echo dev)"

go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o "$OUT" ./cmd/evuproxy

echo "Built ${REPO_ROOT}/${OUT} (version ${VERSION})"

if [[ "${1:-}" == "--install" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Install requires root (e.g. sudo $0 --install)." >&2
    exit 1
  fi
  install -m 0755 "$OUT" "${PREFIX}/bin/evuproxy"
  echo "Installed ${PREFIX}/bin/evuproxy"

  # Keep the boot unit in step with the binary. This is here and not in update.sh because
  # update.sh keeps running its old copy after `git pull`, while this script starts fresh,
  # so an upgrade has the new unit before update.sh restarts it. Nothing is restarted here,
  # so a live confirm window carries on.
  TEMPLATE="${REPO_ROOT}/templates/evuproxy.service"
  BOOT_UNIT="${UNIT_DIR}/evuproxy.service"
  if [[ -f "$BOOT_UNIT" ]]; then
    # The template's binary might be an older one that rejects the flags it passes.
    if grep -qF "ExecStart=${PREFIX}/bin/evuproxy " "$TEMPLATE"; then
      "$SCRIPT_DIR/update-boot-unit.sh" "$TEMPLATE" "$BOOT_UNIT"
      if command -v systemctl >/dev/null 2>&1; then
        systemctl daemon-reload
      fi
    else
      echo "warning: left $BOOT_UNIT alone: the current unit doesn't run ${PREFIX}/bin/evuproxy; see $TEMPLATE" >&2
    fi
  fi
fi
