#!/usr/bin/env bash
# Install optional CrowdSec + nftables bouncer for EvuProxy.
# Not run by scripts/install.sh. See README.md.
#
# Usage (from repo root or this directory):
#   ./contrib/crowdsec/install.sh install
#   make crowdsec-install

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${DIR}/docker-compose.example.yaml"
BOUNCER_NAME="${CROWDSEC_BOUNCER_NAME:-evuproxy-nft-bouncer}"
BOUNCER_VERSION="${CROWDSEC_BOUNCER_VERSION:-0.0.34}"
ENV_FILE="${DIR}/.env"
INSTALL_MODE_FILE="${DIR}/.install-mode"
HOST_INSTALL_MODE_FILE="/etc/evuproxy/crowdsec-install-mode"
ENABLE_HELPER="${DIR}/evuproxy-enable-crowdsec.py"
NATIVE_BOUNCER_TEMPLATE="${DIR}/native-bouncer.yaml.example"
NATIVE_ACQUIS_DEST="/etc/crowdsec/acquis.d/evuproxy.yaml"
NATIVE_BOUNCER_CFG="/etc/crowdsec/bouncers/crowdsec-firewall-bouncer.yaml"
NATIVE_KEY_FILE="/etc/evuproxy/crowdsec-bouncer.key"
DEFAULT_CONFIG="/etc/evuproxy/config.yaml"

cd "$DIR"

die() { printf 'crowdsec install: %s\n' "$*" >&2; exit 1; }
info() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }

run_root() {
	if [[ "$(id -u)" -eq 0 ]]; then
		"$@"
	elif command -v sudo >/dev/null 2>&1; then
		sudo "$@"
	else
		die "need root or sudo for: $*"
	fi
}

prompt_yes() {
	local msg="$1"
	if [[ "${CROWDSEC_INSTALL_YES:-}" == "1" ]]; then
		return 0
	fi
	if [[ ! -t 0 ]]; then
		return 1
	fi
	local ans
	read -r -p "$msg [y/N] " ans || true
	[[ "$ans" =~ ^[Yy]([Ee][Ss])?$ ]]
}

find_evuproxy_config() {
	local cfg=""
	if [[ -n "${EVUPROXY_CONFIG:-}" ]]; then
		cfg="$EVUPROXY_CONFIG"
	elif [[ -f "$DEFAULT_CONFIG" ]]; then
		cfg="$DEFAULT_CONFIG"
	fi
	if [[ -n "$cfg" && -f "$cfg" ]]; then
		printf '%s' "$cfg"
		return 0
	fi
	if [[ -t 0 ]]; then
		read -r -p "Path to EvuProxy config.yaml [$DEFAULT_CONFIG]: " cfg || true
		cfg="${cfg:-$DEFAULT_CONFIG}"
		if [[ -f "$cfg" ]]; then
			printf '%s' "$cfg"
			return 0
		fi
	fi
	return 1
}

config_crowdsec_enabled() {
	local cfg="$1"
	python3 "$ENABLE_HELPER" --check "$cfg"
}

enable_crowdsec_in_config() {
	local cfg="$1"
	run_root python3 "$ENABLE_HELPER" --enable "$cfg"
}

run_evuproxy_reload() {
	local cfg="$1"
	local -a cmd
	if command -v evuproxy >/dev/null 2>&1; then
		cmd=(evuproxy reload --config "$cfg")
	elif [[ -x /usr/local/bin/evuproxy ]]; then
		cmd=(/usr/local/bin/evuproxy reload --config "$cfg")
	else
		die "evuproxy not found in PATH — enable crowdsec in config manually, then run: sudo evuproxy reload --config $cfg"
	fi
	info "running: ${cmd[*]}"
	run_root "${cmd[@]}"
}

ensure_evuproxy_crowdsec() {
	need_cmd python3
	local cfg
	if ! cfg="$(find_evuproxy_config)"; then
		die "EvuProxy config not found — set EVUPROXY_CONFIG or install config at $DEFAULT_CONFIG"
	fi
	info "EvuProxy config: $cfg"
	if config_crowdsec_enabled "$cfg"; then
		info "crowdsec.enabled is already true"
		if command -v nft >/dev/null 2>&1 && ! nft_crowdsec_set_present; then
			warn "nft set crowdsec_block_v4 missing — reload required"
			if prompt_yes "Run evuproxy reload now?"; then
				run_evuproxy_reload "$cfg"
			fi
		fi
		return 0
	fi
	warn "crowdsec.enabled is false or missing in $cfg"
	if prompt_yes "Enable crowdsec.enabled in config and run evuproxy reload?"; then
		enable_crowdsec_in_config "$cfg"
		info "updated config (backup: ${cfg}.bak.crowdsec-install)"
		run_evuproxy_reload "$cfg"
		if command -v nft >/dev/null 2>&1 && ! nft_crowdsec_set_present; then
			warn "nft set still missing after reload — check evuproxy reload output"
		fi
		return 0
	fi
	die "CrowdSec requires crowdsec.enabled: true in EvuProxy config. Enable via UI or re-run with CROWDSEC_INSTALL_YES=1 on a TTY."
}

choose_install_method() {
	local method=""
	if [[ -n "${CROWDSEC_INSTALL_MODE:-}" ]]; then
		method="${CROWDSEC_INSTALL_MODE,,}"
		case "$method" in
			docker | native) printf '%s' "$method"; return 0 ;;
			*) die "CROWDSEC_INSTALL_MODE must be docker or native (got: $CROWDSEC_INSTALL_MODE)" ;;
		esac
	fi
	if [[ ! -t 0 ]]; then
		printf 'docker'
		return 0
	fi
	printf '\nHow should CrowdSec run on this host?\n' >&2
	printf '  1) docker (default) — containerized CrowdSec + nft bouncer\n' >&2
	printf '  2) native — distro packages + systemd on the host\n' >&2
	local choice
	read -r -p "Choice [1]: " choice || true
	case "${choice:-1}" in
		2 | native | n | N) printf 'native' ;;
		*) printf 'docker' ;;
	esac
}

save_install_method() {
	printf '%s\n' "$1" >"$INSTALL_MODE_FILE"
	if [[ "$1" == "docker" || "$1" == "native" ]]; then
		run_root install -d -m 0755 /etc/evuproxy
		printf '%s\n' "$1" | run_root tee "$HOST_INSTALL_MODE_FILE" >/dev/null
		run_root chmod 0644 "$HOST_INSTALL_MODE_FILE"
	fi
}

detect_install_method() {
	if systemctl is-active --quiet crowdsec-firewall-bouncer.service 2>/dev/null; then
		printf 'native'
		return 0
	fi
	if compose ps --status running 2>/dev/null | grep -qE 'crowdsec|crowdsec-firewall-bouncer'; then
		printf 'docker'
		return 0
	fi
	return 1
}

read_install_method() {
	if [[ -n "${CROWDSEC_INSTALL_MODE:-}" ]]; then
		case "${CROWDSEC_INSTALL_MODE,,}" in
			docker | native) printf '%s' "${CROWDSEC_INSTALL_MODE,,}"; return 0 ;;
		esac
	fi
	if [[ -f "$HOST_INSTALL_MODE_FILE" ]]; then
		local m
		m="$(tr -d '[:space:]' <"$HOST_INSTALL_MODE_FILE")"
		if [[ "$m" == "docker" || "$m" == "native" ]]; then
			printf '%s' "$m"
			return 0
		fi
	fi
	if [[ -f "$INSTALL_MODE_FILE" ]]; then
		local m
		m="$(tr -d '[:space:]' <"$INSTALL_MODE_FILE")"
		if [[ "$m" == "docker" || "$m" == "native" ]]; then
			printf '%s' "$m"
			return 0
		fi
	fi
	if detect_install_method; then
		return 0
	fi
	warn "install mode unknown — assuming docker (re-run install or set CROWDSEC_INSTALL_MODE)"
	printf 'docker'
}

need_cmd() {
	command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

compose() {
	if docker compose version >/dev/null 2>&1; then
		docker compose -f "$COMPOSE_FILE" "$@"
	elif command -v docker-compose >/dev/null 2>&1; then
		docker-compose -f "$COMPOSE_FILE" "$@"
	else
		die "docker compose (v2) or docker-compose is required"
	fi
}

docker_cscli() {
	compose exec -T crowdsec cscli "$@"
}

wait_docker_crowdsec() {
	local i
	for i in $(seq 1 120); do
		if docker_cscli lapi status >/dev/null 2>&1; then
			return 0
		fi
		sleep 2
	done
	die "CrowdSec LAPI did not become ready (try: compose logs crowdsec; ensure acquis.yaml is a file — see README troubleshooting)"
}

native_cscli() {
	if command -v cscli >/dev/null 2>&1; then
		run_root cscli "$@"
	else
		die "cscli not found — install CrowdSec packages first (see README.md § Native install)"
	fi
}

check_journal_mounts() {
	local ok=0
	[[ -d /var/log/journal || -d /run/log/journal ]] || ok=1
	if [[ "$ok" -eq 1 ]]; then
		warn "host journal not found under /var/log/journal or /run/log/journal"
		warn "CrowdSec may not read SSH/kernel logs — enable persistent journal or adjust acquis.yaml"
	fi
}

check_evuproxy_set() {
	if ! command -v nft >/dev/null 2>&1; then
		warn "nft not in PATH — skipping EvuProxy set check"
		return 0
	fi
	if nft_crowdsec_set_present; then
		info "EvuProxy set inet evuproxy crowdsec_block_v4 is present"
		return 0
	fi
	warn "nft set crowdsec_block_v4 not found in table inet evuproxy"
}

nft_crowdsec_set_present() {
	command -v nft >/dev/null 2>&1 || return 1
	run_root nft list set inet evuproxy crowdsec_block_v4 >/dev/null 2>&1
}

ensure_local_acquis() {
	if [[ -d acquis.yaml ]]; then
		warn "acquis.yaml is a directory — Docker creates this when compose ran before the file existed"
		rm -rf acquis.yaml
	fi
	if [[ -f acquis.yaml ]]; then
		info "using existing acquis.yaml"
	else
		cp acquis.yaml.example acquis.yaml
		info "created acquis.yaml from acquis.yaml.example"
	fi
}

bouncer_vendor_dir() {
	printf '%s/vendor/crowdsec-firewall-bouncer-v%s' "$DIR" "$BOUNCER_VERSION"
}

ensure_docker_bouncer_binary() {
	local arch dest tmp
	dest="$(bouncer_vendor_dir)"
	if [[ -x "${dest}/crowdsec-firewall-bouncer" ]]; then
		info "using cached bouncer binary in ${dest}"
		return 0
	fi
	need_cmd curl
	arch="$(bouncer_build_arch)"
	info "downloading cs-firewall-bouncer v${BOUNCER_VERSION} (${arch}) …"
	tmp="$(mktemp -d)"
	curl -fsSL "https://github.com/crowdsecurity/cs-firewall-bouncer/releases/download/v${BOUNCER_VERSION}/crowdsec-firewall-bouncer-linux-${arch}.tgz" \
		| tar -xzf - -C "$tmp"
	mkdir -p "$dest"
	install -m 0755 "${tmp}/crowdsec-firewall-bouncer-v${BOUNCER_VERSION}/crowdsec-firewall-bouncer" "${dest}/"
	rm -rf "$tmp"
}

ensure_docker_bouncer_config() {
	if [[ -f docker-bouncer.yaml ]]; then
		info "using existing docker-bouncer.yaml"
	else
		cp docker-bouncer.yaml.example docker-bouncer.yaml
		info "created docker-bouncer.yaml from docker-bouncer.yaml.example"
	fi
}

bouncer_build_arch() {
	case "$(uname -m)" in
	x86_64 | amd64) echo amd64 ;;
	aarch64 | arm64) echo arm64 ;;
	armv7l | armv6l | arm) echo armv7 ;;
	i386 | i686) echo 386 ;;
	ppc64le) echo ppc64le ;;
	riscv64) echo riscv64 ;;
	s390x) echo s390x ;;
	*) die "unsupported machine architecture for bouncer image: $(uname -m)" ;;
	esac
}

write_env_key() {
	local key="$1"
	cat >"$ENV_FILE" <<EOF
# Generated by install.sh — do not commit.
CROWDSEC_BOUNCER_KEY=${key}
CROWDSEC_LAPI_LISTEN=127.0.0.1:8082
CROWDSEC_LAPI_URL=http://127.0.0.1:8082
EOF
	chmod 600 "$ENV_FILE" 2>/dev/null || true
	info "wrote ${ENV_FILE}"
}

# Remint Docker LAPI defaults away from :8080 (host collisions). Returns 0 if .env changed.
migrate_env_lapi_defaults() {
	[[ -f "$ENV_FILE" ]] || return 1
	local before after changed=0
	before="$(cksum <"$ENV_FILE")"
	# Rewrite common stale client URLs (Docker path only; native keeps package :8080).
	# Use '#' delimiter — pattern alternation uses '|'.
	sed -i -E \
		's#^(CROWDSEC_LAPI_URL=)https?://(127\.0\.0\.1|0\.0\.0\.0|localhost):8080/?[[:space:]]*$#\1http://127.0.0.1:8082#' \
		"$ENV_FILE"
	if ! grep -qE '^CROWDSEC_LAPI_LISTEN=' "$ENV_FILE" 2>/dev/null; then
		printf '\nCROWDSEC_LAPI_LISTEN=127.0.0.1:8082\n' >>"$ENV_FILE"
	else
		sed -i -E \
			's#^(CROWDSEC_LAPI_LISTEN=)(127\.0\.0\.1|0\.0\.0\.0|localhost):8080[[:space:]]*$#\1127.0.0.1:8082#' \
			"$ENV_FILE"
	fi
	after="$(cksum <"$ENV_FILE")"
	if [[ "$before" != "$after" ]]; then
		info "migrated LAPI defaults in ${ENV_FILE} to 127.0.0.1:8082"
		return 0
	fi
	return 1
}

read_env_key() {
	if [[ ! -f "$ENV_FILE" ]]; then
		return 1
	fi
	local line
	line="$(grep -E '^CROWDSEC_BOUNCER_KEY=' "$ENV_FILE" 2>/dev/null | tail -1 || true)"
	[[ -n "$line" ]] || return 1
	local val="${line#CROWDSEC_BOUNCER_KEY=}"
	val="$(printf '%s' "$val" | tr -d '[:space:]"'"'"'')"
	[[ -n "$val" ]] || return 1
	printf '%s' "$val"
}

# --- Docker install ---

ensure_docker_collection() {
	if docker_cscli collections list 2>/dev/null | grep -q 'crowdsecurity/linux'; then
		info "Hub collection crowdsecurity/linux already installed"
		return 0
	fi
	info "installing Hub collection crowdsecurity/linux …"
	docker_cscli collections install crowdsecurity/linux
}

ensure_docker_bouncer_key() {
	local key
	if key="$(read_env_key 2>/dev/null)"; then
		info "using CROWDSEC_BOUNCER_KEY from .env"
		return 0
	fi
	if docker_cscli bouncers list 2>/dev/null | grep -qF "$BOUNCER_NAME"; then
		die "bouncer ${BOUNCER_NAME} already exists but .env has no key — delete the bouncer and re-run install:
  docker compose -f docker-compose.example.yaml exec crowdsec cscli bouncers delete ${BOUNCER_NAME}
  rm -f .env && ./install.sh install"
	fi
	info "registering bouncer ${BOUNCER_NAME} with CrowdSec Local API …"
	key="$(docker_cscli bouncers add "$BOUNCER_NAME" -o raw)"
	[[ -n "$key" ]] || die "cscli bouncers add returned empty key"
	write_env_key "$key"
}

cmd_install_docker() {
	need_cmd docker
	check_journal_mounts
	ensure_local_acquis
	ensure_docker_bouncer_config
	local recreate=()
	if migrate_env_lapi_defaults; then
		recreate=(--force-recreate)
	fi
	info "starting CrowdSec (Docker) …"
	compose up -d "${recreate[@]}" crowdsec
	wait_docker_crowdsec
	ensure_docker_collection
	ensure_docker_bouncer_key
	ensure_docker_bouncer_binary
	info "building nftables bouncer image …"
	compose build crowdsec-firewall-bouncer
	info "starting nftables bouncer (Docker) …"
	compose up -d crowdsec-firewall-bouncer
	info "CrowdSec Docker install complete."
}

cmd_up_docker() {
	need_cmd docker
	ensure_local_acquis
	[[ -f docker-bouncer.yaml ]] || die "missing docker-bouncer.yaml — run: ./install.sh install"
	[[ -f "$ENV_FILE" ]] && read_env_key >/dev/null 2>&1 || die "missing .env with CROWDSEC_BOUNCER_KEY — run: ./install.sh install"
	ensure_docker_bouncer_binary
	local recreate=()
	if migrate_env_lapi_defaults; then
		recreate=(--force-recreate)
	fi
	info "starting CrowdSec stack (Docker) …"
	compose up -d --build "${recreate[@]}"
	wait_docker_crowdsec 2>/dev/null || true
}

cmd_down_docker() {
	compose down
	info "stopped CrowdSec Docker stack (data volume kept)"
}

cmd_logs_docker() {
	compose logs -f "${@:-}"
}

# --- Native install ---

need_native_prereqs() {
	command -v cscli >/dev/null 2>&1 || die "native install requires cscli — install CrowdSec from https://docs.crowdsec.net/docs/getting_started/install_crowdsec"
	if ! systemctl list-unit-files crowdsec.service >/dev/null 2>&1; then
		warn "crowdsec.service not found — install the crowdsec package"
	fi
}

ensure_native_acquis() {
	ensure_local_acquis
	if [[ -f "$NATIVE_ACQUIS_DEST" ]] && cmp -s acquis.yaml "$NATIVE_ACQUIS_DEST" 2>/dev/null; then
		info "acquisition config already installed at $NATIVE_ACQUIS_DEST"
		return 0
	fi
	info "installing acquisition config to $NATIVE_ACQUIS_DEST"
	run_root install -d -m 0755 /etc/crowdsec/acquis.d
	run_root install -m 0644 acquis.yaml "$NATIVE_ACQUIS_DEST"
}

ensure_native_collection() {
	if native_cscli collections list 2>/dev/null | grep -q 'crowdsecurity/linux'; then
		info "Hub collection crowdsecurity/linux already installed"
		return 0
	fi
	info "installing Hub collection crowdsecurity/linux …"
	native_cscli collections install crowdsecurity/linux
}

read_native_key() {
	if [[ -f "$NATIVE_KEY_FILE" ]]; then
		tr -d '[:space:]' <"$NATIVE_KEY_FILE"
		return 0
	fi
	return 1
}

write_native_key() {
	local key="$1"
	printf '%s' "$key" | run_root tee "$NATIVE_KEY_FILE" >/dev/null
	run_root chmod 600 "$NATIVE_KEY_FILE"
	info "wrote bouncer API key to $NATIVE_KEY_FILE"
}

ensure_native_bouncer_key() {
	local key
	if key="$(read_native_key 2>/dev/null)"; then
		info "using existing bouncer API key at $NATIVE_KEY_FILE"
		printf '%s' "$key"
		return 0
	fi
	if native_cscli bouncers list 2>/dev/null | grep -qF "$BOUNCER_NAME"; then
		die "bouncer ${BOUNCER_NAME} already exists but $NATIVE_KEY_FILE is missing — rotate:
  sudo cscli bouncers delete ${BOUNCER_NAME}
  sudo rm -f ${NATIVE_KEY_FILE} && ./install.sh install"
	fi
	info "registering bouncer ${BOUNCER_NAME} with CrowdSec Local API …"
	key="$(native_cscli bouncers add "$BOUNCER_NAME" -o raw)"
	[[ -n "$key" ]] || die "cscli bouncers add returned empty key"
	write_native_key "$key"
	printf '%s' "$key"
}

native_bouncer_targets_evuproxy() {
	[[ -f "$NATIVE_BOUNCER_CFG" ]] || return 1
	grep -qE '^[[:space:]]*set-only:[[:space:]]*true[[:space:]]*$' "$NATIVE_BOUNCER_CFG" 2>/dev/null || return 1
	grep -qE '^[[:space:]]*table:[[:space:]]*evuproxy[[:space:]]*$' "$NATIVE_BOUNCER_CFG" 2>/dev/null || return 1
	grep -qE '^blacklists_ipv4:[[:space:]]*crowdsec_block_v4[[:space:]]*$' "$NATIVE_BOUNCER_CFG" 2>/dev/null || return 1
	return 0
}

install_native_bouncer_config() {
	local key="$1"
	info "installing bouncer config to $NATIVE_BOUNCER_CFG"
	run_root install -d -m 0755 /etc/crowdsec/bouncers
	python3 - "$NATIVE_BOUNCER_TEMPLATE" "$key" <<'PY' | run_root tee "$NATIVE_BOUNCER_CFG" >/dev/null
import sys
from pathlib import Path
template = Path(sys.argv[1]).read_text(encoding="utf-8")
key = sys.argv[2]
if "__BOUNCER_KEY__" not in template:
    sys.exit("template missing __BOUNCER_KEY__ placeholder")
sys.stdout.write(template.replace("__BOUNCER_KEY__", key))
PY
	run_root chmod 600 "$NATIVE_BOUNCER_CFG"
}

configure_native_bouncer() {
	local key="$1"
	if native_bouncer_targets_evuproxy; then
		info "bouncer config already targets EvuProxy (inet evuproxy / crowdsec_block_v4)"
		return 0
	fi
	if [[ -f "$NATIVE_BOUNCER_CFG" ]]; then
		warn "existing bouncer config: $NATIVE_BOUNCER_CFG"
		warn "EvuProxy needs set-only bouncer on table evuproxy, set crowdsec_block_v4"
		if [[ "${CROWDSEC_SKIP_BOUNCER_CONFIG:-}" == "1" ]]; then
			warn "CROWDSEC_SKIP_BOUNCER_CONFIG=1 — leaving bouncer config unchanged"
			return 0
		fi
		if [[ "${CROWDSEC_FORCE_BOUNCER_CONFIG:-}" == "1" ]]; then
			local bak="${NATIVE_BOUNCER_CFG}.bak.$(date -u +%Y%m%dT%H%M%SZ)"
			run_root cp -a "$NATIVE_BOUNCER_CFG" "$bak"
			info "backed up existing config to $bak"
		else
			die "Refusing to overwrite existing CrowdSec bouncer config.

Merge manually (see native-bouncer.yaml.example), then re-run install, or use:
  CROWDSEC_FORCE_BOUNCER_CONFIG=1   backup and install EvuProxy bouncer config
  CROWDSEC_SKIP_BOUNCER_CONFIG=1    skip bouncer config (you manage it)

If fail2ban or another tool already uses the host nftables bouncer, consider Docker instead:
  CROWDSEC_INSTALL_MODE=docker ./contrib/crowdsec/install.sh install"
		fi
	fi
	install_native_bouncer_config "$key"
}

start_native_services() {
	if systemctl list-unit-files crowdsec.service 2>/dev/null | grep -q '^crowdsec\.service'; then
		info "enabling and starting crowdsec.service"
		run_root systemctl enable --now crowdsec.service
	else
		warn "crowdsec.service not found"
	fi
	if systemctl list-unit-files crowdsec-firewall-bouncer.service 2>/dev/null | grep -q '^crowdsec-firewall-bouncer\.service'; then
		info "enabling and starting crowdsec-firewall-bouncer.service"
		run_root systemctl enable --now crowdsec-firewall-bouncer.service
	else
		warn "crowdsec-firewall-bouncer.service not found — install nftables bouncer package"
	fi
}

cmd_install_native() {
	need_native_prereqs
	ensure_native_acquis
	info "reloading CrowdSec to pick up acquisition config …"
	run_root systemctl reload crowdsec 2>/dev/null || run_root systemctl restart crowdsec
	ensure_native_collection
	local key
	key="$(ensure_native_bouncer_key)"
	configure_native_bouncer "$key"
	start_native_services
	info "CrowdSec native install complete."
}

cmd_up_native() {
	need_native_prereqs
	info "starting CrowdSec services (native) …"
	run_root systemctl start crowdsec.service
	if systemctl list-unit-files crowdsec-firewall-bouncer.service >/dev/null 2>&1; then
		run_root systemctl start crowdsec-firewall-bouncer.service
	fi
}

cmd_down_native() {
	info "stopping CrowdSec services (native) …"
	run_root systemctl stop crowdsec-firewall-bouncer.service 2>/dev/null || true
	run_root systemctl stop crowdsec.service 2>/dev/null || true
}

# --- Shared commands ---

print_nft_set_status() {
	if command -v nft >/dev/null 2>&1; then
		printf '\n--- nft set (host) ---\n'
		run_root nft list set inet evuproxy crowdsec_block_v4 2>/dev/null || warn "set not present — enable crowdsec in EvuProxy and reload"
	fi
}

print_cscli_status() {
	local runner="$1"
	printf '\n--- bouncers ---\n'
	$runner bouncers list 2>/dev/null || true
	printf '\n--- recent decisions ---\n'
	$runner decisions list 2>/dev/null | head -20 || true
}

cmd_status() {
	local method
	method="$(read_install_method)"
	info "install mode: $method"
	case "$method" in
		native)
			if command -v cscli >/dev/null 2>&1; then
				print_cscli_status "run_root cscli"
			fi
			systemctl is-active crowdsec.service crowdsec-firewall-bouncer.service 2>/dev/null || true
			;;
		*)
			compose ps 2>/dev/null || true
			if docker_cscli version >/dev/null 2>&1; then
				print_cscli_status docker_cscli
			fi
			;;
	esac
	print_nft_set_status
}

cmd_install() {
	ensure_evuproxy_crowdsec
	check_evuproxy_set
	local method
	method="$(choose_install_method)"
	save_install_method "$method"
	info "install method: $method"
	case "$method" in
		native) cmd_install_native ;;
		*) cmd_install_docker ;;
	esac
	cmd_status
	printf '\n'
	info "Next: trigger a scenario (e.g. failed SSH) or add a test ban — see README.md § Verify"
}

cmd_up() {
	case "$(read_install_method)" in
		native) cmd_up_native ;;
		*) cmd_up_docker ;;
	esac
	cmd_status
}

cmd_down() {
	case "$(read_install_method)" in
		native) cmd_down_native ;;
		*) cmd_down_docker ;;
	esac
}

cmd_logs() {
	case "$(read_install_method)" in
		native)
			run_root journalctl -u crowdsec.service -u crowdsec-firewall-bouncer.service -f --no-pager
			;;
		*) cmd_logs_docker "$@" ;;
	esac
}

cmd_bouncer_key() {
	case "$(read_install_method)" in
		native)
			ensure_native_bouncer_key >/dev/null
			configure_native_bouncer "$(read_native_key)"
			info "restart bouncer: sudo systemctl restart crowdsec-firewall-bouncer"
			;;
		*)
			wait_docker_crowdsec 2>/dev/null || compose up -d crowdsec && wait_docker_crowdsec
			if docker_cscli bouncers list 2>/dev/null | grep -qF "$BOUNCER_NAME"; then
				die "bouncer ${BOUNCER_NAME} already registered. Keys are shown only once at creation."
			fi
			local key
			key="$(docker_cscli bouncers add "$BOUNCER_NAME" -o raw)"
			write_env_key "$key"
			info "bouncer key saved to .env — run: ./install.sh up"
			;;
	esac
}

usage() {
	cat <<EOF
Usage: $(basename "$0") [command]

Commands:
  install       EvuProxy config check, then Docker or native CrowdSec setup (default)
  up            Start existing stack (method from .install-mode)
  status        Bouncers, decisions, nft set
  down          Stop stack (Docker: compose down; native: systemctl stop)
  logs          Follow logs
  bouncer-key   Register bouncer and store API key

Environment:
  EVUPROXY_CONFIG         path to config.yaml (default: /etc/evuproxy/config.yaml)
  CROWDSEC_INSTALL_MODE   docker | native (skip interactive method prompt)
  CROWDSEC_BOUNCER_NAME   bouncer name (default: evuproxy-nft-bouncer)
  CROWDSEC_INSTALL_YES=1  accept EvuProxy enable+reload prompt non-interactively
  CROWDSEC_FORCE_BOUNCER_CONFIG=1  (native) backup and replace existing bouncer yaml
  CROWDSEC_SKIP_BOUNCER_CONFIG=1   (native) skip bouncer config when file exists

From repo root: make crowdsec-install  |  make crowdsec-up
EOF
}

main() {
	local cmd="${1:-install}"
	shift || true
	case "$cmd" in
	install) cmd_install ;;
	up) cmd_up ;;
	status) cmd_status ;;
	down) cmd_down ;;
	logs) cmd_logs "$@" ;;
	bouncer-key) cmd_bouncer_key ;;
	-h | --help | help) usage ;;
	*) die "unknown command: $cmd (try --help)" ;;
	esac
}

main "$@"
