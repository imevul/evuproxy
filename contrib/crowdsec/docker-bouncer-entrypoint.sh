#!/bin/sh
set -eu

if [ -z "${CROWDSEC_BOUNCER_KEY:-}" ]; then
	echo "CROWDSEC_BOUNCER_KEY is empty — run install.sh install or set .env before starting the bouncer" >&2
	exit 1
fi

: "${CROWDSEC_LAPI_URL:=http://127.0.0.1:8080}"

envsubst '${CROWDSEC_BOUNCER_KEY} ${CROWDSEC_LAPI_URL}' \
	< /config/crowdsec-firewall-bouncer.yaml \
	> /tmp/crowdsec-firewall-bouncer.yaml

exec crowdsec-firewall-bouncer -c /tmp/crowdsec-firewall-bouncer.yaml
