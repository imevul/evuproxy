#!/bin/sh
set -eu

if [ -z "${CROWDSEC_BOUNCER_KEY:-}" ]; then
	echo "CROWDSEC_BOUNCER_KEY is empty — run install.sh install or set .env before starting the bouncer" >&2
	exit 1
fi

: "${CROWDSEC_LAPI_URL:=http://127.0.0.1:8082}"

awk -v lapi="$CROWDSEC_LAPI_URL" -v key="$CROWDSEC_BOUNCER_KEY" '
{
	gsub(/\$\{CROWDSEC_LAPI_URL\}/, lapi)
	gsub(/\$\{CROWDSEC_BOUNCER_KEY\}/, key)
	print
}' /config/crowdsec-firewall-bouncer.yaml > /tmp/crowdsec-firewall-bouncer.yaml

exec crowdsec-firewall-bouncer -c /tmp/crowdsec-firewall-bouncer.yaml
