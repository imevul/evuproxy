#!/bin/bash
# Wrap CrowdSec's docker_start.sh so LAPI listens on CROWDSEC_LAPI_LISTEN
# (default 127.0.0.1:8082) instead of the image default :8080.
# LOCAL_API_URL alone only rewrites client credentials — not listen_uri.
set -euo pipefail

LISTEN="${CROWDSEC_LAPI_LISTEN:-127.0.0.1:8082}"
export CROWDSEC_LAPI_LISTEN="$LISTEN"

if ! command -v yq >/dev/null 2>&1; then
	echo "evuproxy-crowdsec: yq is required to set api.server.listen_uri to ${LISTEN}" >&2
	exit 1
fi

patch_listen_uri() {
	local f="$1"
	[[ -f "$f" ]] || return 0
	CROWDSEC_LAPI_LISTEN="$LISTEN" yq e -i '.api.server.listen_uri = strenv(CROWDSEC_LAPI_LISTEN)' "$f"
}

# First-boot populate copies from staging with rsync --ignore-existing.
patch_listen_uri /staging/etc/crowdsec/config.yaml
patch_listen_uri /etc/crowdsec/config.yaml

# docker_start.sh ends with `exec crowdsec`; intercept so we re-patch after populate.
REAL_CS="$(command -v crowdsec)"
if [[ -z "$REAL_CS" || "$REAL_CS" == */evu-cs-wrap/* ]]; then
	echo "evuproxy-crowdsec: could not resolve crowdsec binary" >&2
	exit 1
fi
WRAP_DIR=/tmp/evu-cs-wrap
mkdir -p "$WRAP_DIR"
cat >"$WRAP_DIR/crowdsec" <<EOF
#!/bin/bash
set -euo pipefail
LISTEN="\${CROWDSEC_LAPI_LISTEN:-127.0.0.1:8082}"
export CROWDSEC_LAPI_LISTEN="\$LISTEN"
if ! command -v yq >/dev/null 2>&1; then
	echo "evuproxy-crowdsec: yq is required to set api.server.listen_uri" >&2
	exit 1
fi
if [[ -f /etc/crowdsec/config.yaml ]]; then
	yq e -i '.api.server.listen_uri = strenv(CROWDSEC_LAPI_LISTEN)' /etc/crowdsec/config.yaml
fi
exec "$REAL_CS" "\$@"
EOF
chmod +x "$WRAP_DIR/crowdsec"
export PATH="$WRAP_DIR:$PATH"

if [[ -f /docker_start.sh ]]; then
	exec /bin/bash /docker_start.sh "$@"
fi
if [[ -f /bin/docker_start.sh ]]; then
	exec /bin/bash /bin/docker_start.sh "$@"
fi
echo "evuproxy-crowdsec: docker_start.sh not found in image" >&2
exit 1
