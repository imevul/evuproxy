#!/bin/bash
# First thing in the container: adds systemd, then boots it. checks.sh runs as a unit, and the
# container exits with its result. The package's dependencies stay uninstalled, so installing
# it has to bring them in.
set -euo pipefail

if command -v apt-get >/dev/null; then
	export DEBIAN_FRONTEND=noninteractive
	timeout 300 apt-get update -qq
	timeout 300 apt-get install -y -qq --no-install-recommends systemd >/dev/null
else
	timeout 300 dnf install -y -q systemd
fi

cat >/etc/systemd/system/package-test.service <<'EOF'
[Unit]
Description=EvuProxy package test
After=basic.target
SuccessAction=exit
FailureAction=exit
SuccessActionExitStatus=0
FailureActionExitStatus=1

[Service]
Type=oneshot
ExecStart=/bin/bash /test/checks.sh
TimeoutStartSec=600
EOF
mkdir -p /etc/systemd/system/multi-user.target.wants
ln -s /etc/systemd/system/package-test.service /etc/systemd/system/multi-user.target.wants/package-test.service
ln -sf /usr/lib/systemd/system/multi-user.target /etc/systemd/system/default.target

exec /usr/lib/systemd/systemd
