#!/bin/sh
set -e
HOST="${EVUPROXY_API_UPSTREAM:-127.0.0.1:9847}"
UI_LISTEN="${EVUPROXY_UI_LISTEN:-127.0.0.1:9080}"
UI_CONNECT_SRC="${EVUPROXY_UI_CONNECT_SRC:-}"
# Goes into the Content-Security-Policy, so only exact http(s) origins: no wildcards, and nothing
# that could end the directive or the nginx string.
set -f
for origin in $UI_CONNECT_SRC; do
	case "$origin" in
	*[!]A-Za-z0-9:/.[-]*) ;;
	http://?* | https://?*) continue ;;
	esac
	echo "EVUPROXY_UI_CONNECT_SRC: not an http(s) origin: $origin" >&2
	exit 1
done
set +f
sed -i "s|__API_HOST__|${HOST}|g" /etc/nginx/conf.d/default.conf
sed -i "s|__UI_LISTEN__|${UI_LISTEN}|g" /etc/nginx/conf.d/default.conf
sed -i "s|__UI_CONNECT_SRC__|${UI_CONNECT_SRC}|g" /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
