#!/bin/bash
# First thing in the container: adds what a host has, then boots systemd. checks.sh runs as a
# unit, and the container exits with its result.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
timeout 300 apt-get update -qq
timeout 300 apt-get install -y -qq --no-install-recommends \
	ca-certificates curl iproute2 nftables systemd wireguard-tools >/dev/null

cat >/etc/systemd/system/upgrade-test.service <<'EOF'
[Unit]
Description=EvuProxy upgrade test
After=basic.target
SuccessAction=exit
FailureAction=exit
SuccessActionExitStatus=0
FailureActionExitStatus=1

[Service]
Type=oneshot
ExecStart=/bin/bash /test/checks.sh
TimeoutStartSec=400
EOF
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -s /etc/systemd/system/upgrade-test.service /etc/systemd/system/multi-user.target.wants/upgrade-test.service
ln -sf /usr/lib/systemd/system/multi-user.target /etc/systemd/system/default.target

exec /usr/lib/systemd/systemd
