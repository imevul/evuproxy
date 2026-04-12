#!/bin/sh
set -e
HOST="${EVUPROXY_API_UPSTREAM:-127.0.0.1:9847}"
UI_LISTEN="${EVUPROXY_UI_LISTEN:-127.0.0.1:9080}"
sed -i "s|__API_HOST__|${HOST}|g" /etc/nginx/conf.d/default.conf
sed -i "s|__UI_LISTEN__|${UI_LISTEN}|g" /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
