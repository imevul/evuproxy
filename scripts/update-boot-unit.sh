#!/usr/bin/env bash
set -euo pipefail

# Replace an installed evuproxy.service with the repo's template, unless someone has
# changed the installed file. Run by scripts/update.sh; does not reload systemd.
# Usage: update-boot-unit.sh TEMPLATE INSTALLED

# Every evuproxy.service we have shipped, as installed. Add the new hash whenever
# templates/evuproxy.service changes; cmd/evuproxy/boot_unit_test.go checks this.
SHIPPED_SHA256=(
  c388b79b40bc11ffba657dd509c149fd2934f23ea1a47a8b5a65d79981edaf49
  df03697d6eda22ff33efe69d3fc1aae189452335433ffedae04e06447d4476a6
)

template=$1
installed=$2

[[ -f "$installed" ]] || exit 0

warn_without_boot() {
  echo "warning: $1. It needs \`evuproxy reload --boot\`, or a reboot or restart applies config.yaml even with apply.confirm on; see $template" >&2
}

current="$(sha256sum "$installed" | cut -d' ' -f1)"
wanted="$(sha256sum "$template" | cut -d' ' -f1)"
if [[ "$current" != "$wanted" ]]; then
  shipped=0
  for hash in "${SHIPPED_SHA256[@]}"; do
    [[ "$current" == "$hash" ]] && shipped=1
  done
  if [[ "$shipped" -eq 1 ]]; then
    install -m 0644 "$template" "$installed"
    echo "Updated $installed"
  elif ! grep -q '^ExecStart=.*reload.*--boot' "$installed"; then
    warn_without_boot "$installed has local changes, so it was left alone"
  fi
fi

# A drop-in that sets ExecStart replaces the one in the unit, whatever was done above.
for dropin in "$installed.d"/*.conf; do
  if [[ -f "$dropin" ]] && grep -q '^ExecStart=.' "$dropin" && ! grep -q '^ExecStart=.*reload.*--boot' "$dropin"; then
    warn_without_boot "$dropin overrides ExecStart"
  fi
done
