#!/bin/sh
set -eu

if [ -z "${CROWDSEC_BOUNCER_KEY:-}" ]; then
	echo "CROWDSEC_BOUNCER_KEY is empty — run install.sh install or set .env before starting the bouncer" >&2
	exit 1
fi

: "${CROWDSEC_LAPI_URL:=http://127.0.0.1:8080}"

while IFS= read -r line || [ -n "$line" ]; do
	line=${line//\$\{CROWDSEC_LAPI_URL\}/$CROWDSEC_LAPI_URL}
	line=${line//\$\{CROWDSEC_BOUNCER_KEY\}/$CROWDSEC_BOUNCER_KEY}
	printf '%s\n' "$line"
done < /config/crowdsec-firewall-bouncer.yaml > /tmp/crowdsec-firewall-bouncer.yaml

exec crowdsec-firewall-bouncer -c /tmp/crowdsec-firewall-bouncer.yaml
