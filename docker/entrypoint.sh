#!/bin/sh
set -e
HOST="${EVUPROXY_API_UPSTREAM:-host.docker.internal:9847}"
sed -i "s|__API_HOST__|${HOST}|g" /etc/nginx/conf.d/default.conf
exec nginx -g 'daemon off;'
