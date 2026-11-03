#!/usr/bin/env bash
set -euo pipefail

# Upgrade a prebuilt evuproxy binary from a GitHub Release, with no clone and no Go.
# Git installs use scripts/update.sh, and packages use their package manager.
#
#   sudo ./upgrade-binary.sh                   # the latest release
#   sudo ./upgrade-binary.sh --version 0.18.0  # that release, which may be older
#   sudo ./upgrade-binary.sh --rollback        # back to the binary the last run replaced
#
# The new binary is downloaded and checked in a temporary directory beside the old one, so a
# failure before the swap leaves the install as it was. The swap keeps the old binary as
# PREFIX/bin/evuproxy.previous, then restarts the EvuProxy services that are active.
#
# SHA256SUMS comes from the same release as the binary: it catches a corrupt download, not a
# compromised release.
#
# Optional env:
#   PREFIX                default /usr/local
#   CONFIG_DIR            default /etc/evuproxy
#   EVUPROXY_RELEASE_URL  default https://github.com/imevul/evuproxy/releases

PREFIX="${PREFIX:-/usr/local}"
CONFIG="${CONFIG_DIR:-/etc/evuproxy}/config.yaml"
RELEASE_URL="${EVUPROXY_RELEASE_URL:-https://github.com/imevul/evuproxy/releases}"
TARGET="$PREFIX/bin/evuproxy"
PREVIOUS="$TARGET.previous"
UNITS=(evuproxy.service evuproxy-api.service evuproxy-metrics.service)

die() {
  echo "upgrade-binary.sh: $*" >&2
  exit 1
}
warn() {
  echo "warning: $*" >&2
}
have() { command -v "$1" >/dev/null 2>&1; }
version_of() { "$1" version 2>/dev/null || true; }

usage() {
  echo "Usage: upgrade-binary.sh [--version X.Y.Z | --rollback]"
}

want_version=""
rollback=0
while [[ $# -gt 0 ]]; do
  case "$1" in
  --version)
    [[ $# -ge 2 ]] || die "--version needs a value"
    want_version="${2#v}"
    shift 2
    ;;
  --rollback)
    rollback=1
    shift
    ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 1
    ;;
  esac
done
[[ -z "$want_version" || "$rollback" -eq 0 ]] || die "--version and --rollback can't be combined"

case "$RELEASE_URL" in
https://*) ;;
*) die "EVUPROXY_RELEASE_URL must start with https://" ;;
esac

[[ "$(id -u)" -eq 0 ]] || die "run as root (e.g. sudo bash upgrade-binary.sh)"

[[ ! -L "$TARGET" ]] || die "$TARGET is a symlink; set PREFIX to where the binary really is"
[[ -x "$TARGET" ]] || die "no binary at $TARGET. This only upgrades an existing install: set PREFIX if it is elsewhere. A package install upgrades through its package manager."

valid_version() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }
[[ -z "$want_version" ]] || valid_version "$want_version" || die "not a version: $want_version"

download() {
  curl --proto '=https' --proto-redir '=https' -fsSL --retry 2 --connect-timeout 20 --max-time 600 "$@"
}

# Stops before the swap if a check says this binary shouldn't go live here. $1 is the binary.
restart_boot_unit=1
preflight() {
  local bin=$1 status exec_start out

  # A revert timer is waiting on the current session, and restarting evuproxy.service would be
  # refused. Binaries from before confirm mode have no reload-status, which skips this.
  if [[ -r "$CONFIG" ]] && status="$("$TARGET" reload-status --config "$CONFIG" 2>/dev/null)" &&
    ! grep -q '"session": null' <<<"$status"; then
    die "an Apply is waiting for confirmation or failed to revert. Run evuproxy reload-confirm or evuproxy reload-revert first. The install was not changed."
  fi

  # The effective command, so this also sees a drop-in that replaces ExecStart.
  if have systemctl; then
    exec_start="$(systemctl show -p ExecStart --value evuproxy.service 2>/dev/null || true)"
    if [[ -n "$exec_start" ]]; then
      out="$("$bin" reload --help 2>&1 || true)"
      if [[ "$exec_start" == *--boot* && "$out" != *--boot* ]]; then
        die "evuproxy.service runs reload --boot, which this binary doesn't know, so it would fail and leave the host without its firewall at the next boot. Install the matching release's templates/evuproxy.service, run systemctl daemon-reload, and try again. The install was not changed."
      fi
      if [[ "$exec_start" != *--boot* && "$out" == *--boot* ]]; then
        restart_boot_unit=0
      fi
    fi
  fi

  if [[ -r "$CONFIG" ]] && "$bin" validate --help >/dev/null 2>&1; then
    if ! out="$("$bin" validate --config "$CONFIG" 2>&1)"; then
      echo "$out" >&2
      die "this binary rejects $CONFIG, so restarting or rebooting would fail. Fix the config (see CHANGELOG.md) and try again. The install was not changed."
    fi
  fi
}

current="$(version_of "$TARGET")"

work="$(mktemp -d "$PREFIX/bin/.evuproxy-upgrade.XXXXXX")"
trap 'rm -rf "$work"' EXIT
candidate="$work/evuproxy"

if [[ "$rollback" -eq 1 ]]; then
  [[ -x "$PREVIOUS" ]] || die "nothing to roll back to: no $PREVIOUS"
  cp -p "$PREVIOUS" "$candidate"
  new="$(version_of "$candidate")"
  [[ -n "$new" ]] || die "$PREVIOUS doesn't run. The install was not changed."
else
  have curl || die "curl is required"
  have sha256sum || die "sha256sum is required"

  case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) die "no release binaries for $(uname -m)" ;;
  esac

  new="$want_version"
  if [[ -z "$new" ]]; then
    # github.com redirects this to .../tag/vX.Y.Z, without the API's rate limit.
    latest_url="$(download -o /dev/null -w '%{url_effective}' "$RELEASE_URL/latest")" ||
      die "couldn't find the latest release at $RELEASE_URL. The install was not changed."
    new="${latest_url##*/tag/v}"
    valid_version "$new" || die "couldn't read a version from $latest_url. The install was not changed."
    # sort -V also orders a git describe version, so a newer build isn't downgraded by surprise.
    if [[ -n "$current" && "$(printf '%s\n%s\n' "$new" "${current#v}" | sort -V | tail -n 1)" != "$new" ]]; then
      echo "$TARGET is $current, newer than the latest release $new. Use --version to install an older one."
      exit 0
    fi
  fi

  if [[ "${current#v}" == "$new" ]]; then
    echo "$TARGET is already $new."
    exit 0
  fi

  asset="evuproxy-$new-linux-$arch"
  base="$RELEASE_URL/download/v$new"
  echo "Downloading $asset ..."
  download "$base/SHA256SUMS" -o "$work/SHA256SUMS" ||
    die "couldn't download $base/SHA256SUMS. The install was not changed."
  download "$base/$asset" -o "$candidate" ||
    die "couldn't download $base/$asset. The install was not changed."

  # The release writes names as ./name.
  wanted="$(awk -v f="$asset" '$2 == f || $2 == "./" f { print $1; exit }' "$work/SHA256SUMS")"
  [[ -n "$wanted" ]] || die "SHA256SUMS has no entry for $asset. The install was not changed."
  got="$(sha256sum "$candidate" | cut -d' ' -f1)"
  [[ "$got" == "$wanted" ]] || die "checksum mismatch for $asset: expected $wanted, got $got. The install was not changed."

  chmod 0755 "$candidate"
  # Catches a binary for the wrong architecture, or one that isn't the release it claims to be.
  got="$(version_of "$candidate")"
  [[ "$got" == "$new" ]] || die "$asset reports version '${got}', expected $new. The install was not changed."
fi

preflight "$candidate"

# Renames, so a running service keeps its old binary and nothing sees a half-written file.
cp -p "$TARGET" "$work/previous"
mv -f "$work/previous" "$PREVIOUS"
mv -f "$candidate" "$TARGET"
echo "Installed $TARGET ($new), replacing ${current:-an unknown version}; kept the old binary as $PREVIOUS"

failed=()
restarted=()
if have systemctl; then
  for unit in "${UNITS[@]}"; do
    systemctl is-active --quiet "$unit" 2>/dev/null || continue
    if [[ "$(systemctl show -p ExecStart --value "$unit" 2>/dev/null)" != *"path=$TARGET "* ]]; then
      warn "$unit runs a different binary than $TARGET, so it was not restarted"
      continue
    fi
    if [[ "$unit" == evuproxy.service && "$restart_boot_unit" -eq 0 ]]; then
      warn "evuproxy.service has no --boot, so it was not restarted: that would apply any unconfirmed edits in config.yaml, and so will a reboot. Install this release's templates/evuproxy.service and run systemctl daemon-reload. See docs/config.md#confirm-or-revert-apply"
      continue
    fi
    echo "Restarting $unit ..."
    if systemctl restart "$unit"; then
      restarted+=("$unit")
    else
      failed+=("$unit")
    fi
  done
  # A long-running service can pass the restart and then exit.
  if [[ "${#restarted[@]}" -gt 0 ]]; then
    sleep 2
    for unit in "${restarted[@]}"; do
      systemctl is-active --quiet "$unit" || failed+=("$unit")
    done
  fi
else
  echo "No systemctl here: restart anything that runs evuproxy yourself."
fi

# Same refresh as scripts/update.sh; the release may have changed this drop-in.
if [[ -r "$CONFIG" ]] && ! "$TARGET" ensure-wg-networkd --config "$CONFIG"; then
  warn "ensure-wg-networkd failed (non-fatal); run: $TARGET ensure-wg-networkd --config $CONFIG"
fi

if [[ "${#failed[@]}" -gt 0 ]]; then
  die "$TARGET is $new, but these services failed: ${failed[*]}. See journalctl -u <unit>; to go back, run upgrade-binary.sh --rollback."
fi
echo "Upgrade complete. To go back: upgrade-binary.sh --rollback"
