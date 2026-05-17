#!/usr/bin/env bash
set -euo pipefail

# EvuProxy — decrypt an admin‑UI onboarding bundle and run scripts/peer-install.sh
#
# Dependencies: bash, curl, openssl 3+ (with `openssl kdf`), xxd, root on the peer.
# Wire format matches web/static/app.js (EVUB peer bundle blob).

# Default tracks GitHub branch `main`: tag-pinned URLs in defaults would stale-drift unless updated every release. `main` is a moving branch.
# Override EVUPROXY_PEER_INSTALL_SCRIPT_URL for a tagged peer-install.sh raw URL plus checksum discipline.
DEFAULT_PEER_INSTALL_URL="https://raw.githubusercontent.com/imevul/evuproxy/main/scripts/peer-install.sh"

die() {
  printf '%s: %s\n' "$(basename "$0")" "$*" >&2
  exit 1
}

have_cmd() { command -v "$1" >/dev/null 2>&1; }

need_openssl_kdf() {
  have_cmd openssl || die "openssl not found."
  openssl kdf -help >/dev/null 2>&1 ||
    die "This openssl lacks the 'openssl kdf' CLI (need OpenSSL 3+)."
}

have_cmd xxd || die "Missing xxd (install vim-common / xxd)."
have_cmd curl || die "curl not found."

# Require HTTPS URLs for remote installers (reject file:, ftp:, etc.).
curl_fetch_https() {
  local url="$1"
  shift
  case "$url" in
  https://*) ;;
  *) die "URL must start with https://" ;;
  esac
  curl --proto '=https' --proto-redir '=https' "$@" "$url"
}

need_openssl_kdf

# --- Base64 ciphertext bundle (logical single line after whitespace stripping) ---
b64_compact_raw() {
  local compact="$1"
  compact="$(printf '%s' "$compact" | tr -d ' \t\n\r')"
  printf '%s' "$compact" | openssl base64 -d -A 2>/dev/null ||
    printf '%s' "$compact" | openssl base64 -d 2>/dev/null ||
    printf '%s' "$compact" | base64 --decode 2>/dev/null ||
    printf '%s' "$compact" | base64 -d 2>/dev/null ||
    die "Blob is not valid base64."
}

raw_to_hex_lc() {
  xxd -p | tr -d '\n'
}

be32_from_hex8() {
  local x=${1,,}
  ((${#x} == 8)) || die "internal be32 hex."
  printf '%u' "$(( (
    (0x${x:0:2} << 24) | (0x${x:2:2} << 16) | (0x${x:4:2} << 8) | 0x${x:6:2}
  ) ))"
}

read_twoline_stdio() {
  local pass_line blob_line
  if ! IFS= read -r pass_line; then die "stdin: unlock line missing"; fi
  if ! IFS= read -r blob_line; then die "stdin: base64 blob missing"; fi
  passphrase="${pass_line//$'\r'/}"
  passphrase="$(printf '%s' "$passphrase" | tr -d '\n')"
  blob_compact_b64="$(printf '%s' "$blob_line" | tr -d ' \t\n\r')"
}

read_from_env_unlock() {
  passphrase="${EVUPROXY_PEER_UNLOCK:-}"
  passphrase="${passphrase//$'\r'/}"
  passphrase="$(printf '%s' "$passphrase" | tr -d '\n')"
  blob_compact_b64="$(printf '%s' "${EVUPROXY_PEER_BLOB_B64:-}" | tr -d ' \t\n\r')"
}

read_from_cred_files() {
  local uf="$1" bf="$2"
  passphrase="$(trim_file_one_line "$(<"$uf")")"
  blob_compact_b64="$(printf '%s' "$(cat "$bf")" | tr -d ' \t\n\r')"
}

trim_file_one_line() {
  printf '%s' "${1//$'\r'/}" | tr -d '\n'
}

unpack_and_decrypt_json() {
  local raw_hex hl magic_lc salt_len_hex iterations salt_hex iv_hex ct_len
  local hex_ct_begin hex_mac_begin expect_mac_hex dk_hex aes_hex mk_hex mac_actual_hex
  local plain_json ct_hex_chars

  raw_hex="$(b64_compact_raw "$blob_compact_b64" | raw_to_hex_lc)"
  hl=${#raw_hex}

  magic_lc=${raw_hex:0:8}
  [[ ${magic_lc,,} == 45565542 ]] || die "Unknown bundle magic — copy again from EvuProxy."

  salt_len_hex=${raw_hex:18:2}
  (( $(printf '%u' "$((16#${salt_len_hex}))") == 16 )) || die "Invalid bundle salt length."

  iterations="$(be32_from_hex8 "${raw_hex:10:8}")"
  PEER_BUNDLE_MIN_PBKDF2_ITER=310000
  (( iterations >= PEER_BUNDLE_MIN_PBKDF2_ITER )) ||
    die "Bundle PBKDF2 iteration count ($iterations) is below minimum $PEER_BUNDLE_MIN_PBKDF2_ITER."

  salt_hex="${raw_hex:20:32}"
  iv_hex="${raw_hex:52:32}"
  ct_len="$(be32_from_hex8 "${raw_hex:84:8}")"

  hex_ct_begin=$((46 * 2))
  hex_mac_begin=$((hex_ct_begin + ct_len * 2))
  ((hex_mac_begin + 64 == hl)) || die "Bundle length inconsistent with ciphertext size."

  expect_mac_hex="${raw_hex:hex_mac_begin:64}"
  ct_hex_chars="${raw_hex:hex_ct_begin:$((hex_mac_begin - hex_ct_begin))}"

  dk_hex="$(
    printf '%s' "$passphrase" | openssl kdf \
      -keylen 64 -binary \
      -kdfopt "pass:${passphrase}" \
      -kdfopt "hexsalt:${salt_hex}" \
      -kdfopt "iter:${iterations}" \
      -digest SHA256 PBKDF2 | raw_to_hex_lc
  )" || die "PBKDF2 failed."

  aes_hex="${dk_hex:0:64}"
  mk_hex="${dk_hex:64:64}"

  mac_actual_hex="$(
    { printf '%s' "$iv_hex"; printf '%s' "$ct_hex_chars"; } |
      xxd -r -p |
      openssl dgst -sha256 -binary \
        -mac HMAC -macopt "hexkey:${mk_hex}" | raw_to_hex_lc
  )"

  if [[ ${mac_actual_hex,,} != ${expect_mac_hex,,} ]]; then
    die "Unlock passphrase mismatch or corrupted bundle."
  fi

  plain_json="$(
    printf '%s' "$ct_hex_chars" | xxd -r -p |
      openssl enc -aes-256-cbc -d -K "${aes_hex}" -iv "${iv_hex}" -nosalt
  )" || die "openssl decrypt failed (wrong passphrase or damaged blob)."
  printf '%s' "$plain_json"
}

json_get_string_value() {
  local key="$1" json="$2"
  printf '%s' "$json" | sed -n 's/.*"'"${key}"'":"\([^"]*\)".*/\1/p' | head -n 1
}

json_need_v_one() {
  [[ "$1" =~ \"v\":[[:space:]]*1[,}] ]] ||
    die 'Unsupported decrypted payload schema (need compact "v":1 from the EvuProxy UI).'
}

run_peer_install_payload() {
  local payload="$1"

  json_need_v_one "$payload"

  local priv tip spk ep ips iface
  priv="$(json_get_string_value peerPrivateKey "$payload")"
  tip="$(json_get_string_value peerTunnelAddress "$payload")"
  spk="$(json_get_string_value serverPublicKey "$payload")"
  ep="$(json_get_string_value endpoint "$payload")"
  ips="$(json_get_string_value allowedIPs "$payload")"
  iface="$(json_get_string_value interfaceName "$payload")"
  iface="$(printf '%s' "$iface" | tr -d ' \t\n\r')"
  iface="${iface:-evuproxy}"

  [[ -n "$priv" && -n "$tip" && -n "$spk" && -n "$ep" && -n "$ips" ]] ||
    die "Decoded bundle is missing WG fields."

  export EVUPROXY_WG_PRIVATE_KEY="$priv"
  export EVUPROXY_WG_ADDRESS="$tip"
  export EVUPROXY_WG_SERVER_PUBLIC_KEY="$spk"
  export EVUPROXY_WG_ENDPOINT="$ep"
  export EVUPROXY_WG_ALLOWED_IPS="$ips"
  export EVUPROXY_WG_INTERFACE="$iface"

  local sh_abs pin_url=""
  if [[ -n "${peer_install_local:-}" ]]; then
    sh_abs="$(realpath "$peer_install_local" 2>/dev/null || readlink -f "$peer_install_local" 2>/dev/null || printf '%s' "$peer_install_local")"
    [[ -f "$sh_abs" ]] || die "--peer-install-sh missing: $sh_abs"
    bash "$sh_abs"
    return
  fi

  pin_url="${EVUPROXY_PEER_INSTALL_SCRIPT_URL:-}"
  pin_url="$(printf '%s' "$pin_url" | tr -d ' \t\n\r')"
  [[ -n "$pin_url" ]] || pin_url="$DEFAULT_PEER_INSTALL_URL"

  local tmp=""
  tmp="$(mktemp)"
  chmod 0600 "$tmp"
  curl_fetch_https "$pin_url" -fsSL -o "$tmp" || die "Failed to fetch peer-install.sh."

  local ec_peer
  set +e
  bash "$tmp"
  ec_peer=$?
  set -e
  rm -f -- "$tmp"
  (( ec_peer == 0 )) || die "peer-install script exited ${ec_peer}."
}

usage() {
  cat >&2 <<'EOF'
Decrypt an EvuProxy peer onboarding bundle and run scripts/peer-install.sh (as root).

  --secret UNLOCK_HEX  --blob BASE64_OR_PATH
      Unlock passphrase (hex line from the EvuProxy admin UI) plus base64 bundle (logical one line).

  --stdin
      Read passphrase then base64 blob from stdin.

  --from-env
      Use EVUPROXY_PEER_UNLOCK and EVUPROXY_PEER_BLOB_B64.

  --unlock-passphrase-file PATH  --blob-file PATH
      Same as stdin, but paths to chmod-600 files.

Optional:
  --peer-install-sh PATH      Use this peer-install.sh (air-gapped / verified copy).
  --peer-install-script-url U Override HTTPS URL for peer-install.sh.
EOF
}

passphrase=""
blob_compact_b64=""
peer_install_local=""
stdin_flag=""
from_env_flag=""
cli_secret=""
cli_blob=""
unlock_file=""
blob_file=""
help_flag=""

while [[ $# -gt 0 ]]; do
  case "$1" in
  --help | -h)
    help_flag=1
    shift
    ;;
  --stdin)
    stdin_flag=1
    shift
    ;;
  --secret)
    cli_secret="${2:-}"
    shift 2 || die "--secret needs a value."
    ;;
  --blob)
    cli_blob="${2:-}"
    shift 2 || die "--blob needs a value."
    ;;
  --from-env)
    from_env_flag=1
    shift
    ;;
  --unlock-passphrase-file)
    unlock_file="${2:-}"
    shift 2 || die "--unlock-passphrase-file needs a path."
    ;;
  --blob-file)
    blob_file="${2:-}"
    shift 2 || die "--blob-file needs a path."
    ;;
  --peer-install-sh)
    peer_install_local="${2:-}"
    shift 2 || die "--peer-install-sh needs a path."
    ;;
  --peer-install-script-url)
    EVUPROXY_PEER_INSTALL_SCRIPT_URL="${2:-}"
    shift 2 || die "--peer-install-script-url needs a URL."
    ;;
  *)
    die "unknown argument: $1 (try $(basename "$0") --help)"
    ;;
  esac
done

if [[ -n "${help_flag:-}" ]]; then
  usage
  exit 0
fi

cred_modes=0
[[ -n "${cli_secret:-}" || -n "${cli_blob:-}" ]] && cred_modes=$((cred_modes + 1))
[[ -n "${stdin_flag:-}" ]] && cred_modes=$((cred_modes + 1))
[[ -n "${from_env_flag:-}" ]] && cred_modes=$((cred_modes + 1))
[[ -n "${unlock_file:-}" && -n "${blob_file:-}" ]] && cred_modes=$((cred_modes + 1))

((cred_modes <= 1)) || die "Choose one credential mode (see $(basename "$0") --help)."

read_cli_blob_value() {
  local b="$1"
  if [[ -f "$b" && -r "$b" ]]; then
    blob_compact_b64="$(printf '%s' "$(cat "$b")" | tr -d ' \t\n\r')"
    return 0
  fi
  blob_compact_b64="$(printf '%s' "$b" | tr -d ' \t\n\r')"
}

if [[ -n "${cli_secret:-}" || -n "${cli_blob:-}" ]]; then
  [[ -n "${cli_secret:-}" && -n "${cli_blob:-}" ]] || die "Provide both --secret and --blob."
  passphrase="${cli_secret//$'\r'/}"
  passphrase="$(printf '%s' "$passphrase" | tr -d '\n')"
  read_cli_blob_value "$cli_blob"
elif [[ -n "${unlock_file:-}" || -n "${blob_file:-}" ]]; then
  [[ -n "${unlock_file:-}" && -n "${blob_file:-}" ]] ||
    die "Provide both --unlock-passphrase-file and --blob-file."
  [[ -r "$unlock_file" && -r "$blob_file" ]] || die "Passphrase/blob file not readable."
  read_from_cred_files "$unlock_file" "$blob_file"
elif [[ -n "${from_env_flag:-}" ]]; then
  read_from_env_unlock
elif [[ -n "${stdin_flag:-}" ]]; then
  read_twoline_stdio
else
  die "Provide credentials: --secret + --blob, --stdin, --from-env, or passphrase + blob files (--help)."
fi

[[ -n "${passphrase}" ]] || die "Unlock passphrase empty."
[[ -n "${blob_compact_b64}" ]] || die "Encrypted blob empty."

if [[ "$(id -u)" -ne 0 ]]; then
  die "Run as root (sudo). peer-install configures WireGuard and wg-quick."
fi

payload_json="$(unpack_and_decrypt_json)"

run_peer_install_payload "$payload_json"
printf '%s\n' "EvuProxy peer onboarding completed." >&2
