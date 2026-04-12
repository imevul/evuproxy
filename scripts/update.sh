#!/usr/bin/env bash
set -euo pipefail

# Pull latest sources, rebuild evuproxy, and restart services that use it.
# From repo root: ./scripts/update.sh
#
# - Builds with scripts/rebuild.sh (see that script for PREFIX / OUT).
# - If EvuProxy systemd units are installed under /etc/systemd/system/, installs
#   the binary to PREFIX (default /usr/local) and restarts active units.
# - If this repo's default Docker Compose UI stack is running, rebuilds and
#   recreates those containers.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

git pull

SYSTEMD_UNITS=0
if [[ -f /etc/systemd/system/evuproxy-api.service ]] || [[ -f /etc/systemd/system/evuproxy.service ]]; then
  SYSTEMD_UNITS=1
fi

if [[ "$SYSTEMD_UNITS" -eq 1 ]]; then
  if [[ "$(id -u)" -eq 0 ]]; then
    "$SCRIPT_DIR/rebuild.sh" --install
  else
    sudo "$SCRIPT_DIR/rebuild.sh" --install
  fi
else
  "$SCRIPT_DIR/rebuild.sh"
fi

if [[ "$SYSTEMD_UNITS" -eq 1 ]] && command -v systemctl >/dev/null 2>&1; then
  SUDO=()
  if [[ "$(id -u)" -ne 0 ]]; then
    SUDO=(sudo)
  fi
  for unit in evuproxy.service evuproxy-api.service; do
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
      "${SUDO[@]}" systemctl restart "$unit"
    fi
  done
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  if [[ -f "$REPO_ROOT/docker-compose.yml" ]]; then
    if docker compose -f "$REPO_ROOT/docker-compose.yml" ps -q 2>/dev/null | grep -q .; then
      docker compose -f "$REPO_ROOT/docker-compose.yml" up --build -d
    fi
  fi
fi

echo "Update complete."
