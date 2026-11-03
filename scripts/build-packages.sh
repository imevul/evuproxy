#!/usr/bin/env bash
set -euo pipefail

# Build .deb and RPM packages from binaries that are already built (requires Go on PATH, for nfpm).
# Usage: ./scripts/build-packages.sh VERSION DIR [ARCH...]
#   Reads DIR/evuproxy-VERSION-linux-ARCH and writes the packages to DIR.
#   ARCH is a Go architecture and defaults to amd64 and arm64.
# The binary goes in /usr/bin, so the units are rewritten from the /usr/local/bin in templates/.

NFPM=github.com/goreleaser/nfpm/v2/cmd/nfpm@v2.48.0

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 VERSION DIR [ARCH...]" >&2
  exit 1
fi

export VERSION=$1
DIST="$(cd "$2" && pwd)"
shift 2
if [[ $# -eq 0 ]]; then
  set -- amd64 arm64
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

GOBIN="$STAGE/tools" go install "$NFPM"

mkdir "$STAGE/units"
for unit in "$REPO_ROOT"/templates/evuproxy*; do
  sed 's#/usr/local/bin/evuproxy#/usr/bin/evuproxy#g' "$unit" >"$STAGE/units/$(basename "$unit")"
done
if grep -l /usr/local "$STAGE"/units/*; then
  echo "A unit still points at /usr/local." >&2
  exit 1
fi
install -m 0644 "$REPO_ROOT/config/evuproxy.example.yaml" "$STAGE/config.example.yaml"
install -m 0644 "$REPO_ROOT/LICENSE" "$STAGE/LICENSE"
install -m 0755 "$REPO_ROOT"/packaging/*.sh "$STAGE/"

cd "$STAGE"
for ARCH in "$@"; do
  export ARCH
  install -m 0755 "$DIST/evuproxy-${VERSION}-linux-${ARCH}" evuproxy
  for packager in deb rpm; do
    tools/nfpm package --config "$REPO_ROOT/packaging/nfpm.yaml" --packager "$packager" --target "$DIST/"
  done
done
