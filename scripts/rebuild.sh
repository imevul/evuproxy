#!/usr/bin/env bash
set -euo pipefail

# Build EvuProxy from this repository (requires Go 1.22+ on PATH).
# Usage:
#   ./scripts/rebuild.sh              # writes ./evuproxy in repo root
#   sudo ./scripts/rebuild.sh --install   # build and install to PREFIX/bin
#
# Optional env:
#   PREFIX   default /usr/local (used with --install)
#   OUT      output filename, default evuproxy (under repo root)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

OUT="${OUT:-evuproxy}"
PREFIX="${PREFIX:-/usr/local}"
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
fi
