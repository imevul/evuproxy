#!/bin/bash
# Runs scripts/upgrade-binary.sh in a throwaway container that boots systemd, against a local
# stand-in for GitHub Releases. See README.md.
#
# Exits 0 if every check passed, 1 if any failed, and 100 if it could not run.
set -uo pipefail

IMAGE=debian:12
DEADLINE_SECONDS=600

command -v docker >/dev/null || { echo "upgrade-test: docker is required" >&2; exit 100; }
command -v go >/dev/null || { echo "upgrade-test: go is required" >&2; exit 100; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 100

work=$(mktemp -d) || exit 100
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin" "$work/results" || exit 100
chmod 755 "$work" "$work/bin"
chmod 777 "$work/results"

for version in 0.0.1 0.0.2 0.0.3; do
	CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$version" \
		-o "$work/bin/evuproxy-$version" ./cmd/evuproxy || { echo "upgrade-test: go build failed" >&2; exit 100; }
done
CGO_ENABLED=0 go build -trimpath -o "$work/bin/server" ./devtools/upgrade-test/server || { echo "upgrade-test: go build failed" >&2; exit 100; }

name="evuproxy-upgrade-test-$$"
# systemd as PID 1 needs a writable cgroup tree, which Docker only gives a privileged container.
# The network namespace stays the container's own, so the firewall rules evuproxy.service loads
# never reach this host. Nothing is published, and --rm removes all of it.
timeout -k 10 "$DEADLINE_SECONDS" docker run --rm --name "$name" \
	--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
	-e container=docker \
	-v "$PWD/devtools/upgrade-test:/test:ro" -v "$PWD/scripts:/scripts:ro" -v "$PWD/templates:/templates:ro" \
	-v "$work/bin:/test-bin:ro" -v "$work/results:/results" \
	"$IMAGE" bash /test/entry.sh >"$work/results/docker.log" 2>&1
status=$?
if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
	echo "upgrade-test: hit the ${DEADLINE_SECONDS}s deadline" >&2
	docker kill "$name" >/dev/null 2>&1
fi
if [ -f "$work/results/checks.log" ]; then
	cat "$work/results/checks.log"
else
	cat "$work/results/docker.log"
fi
# Both, so a systemd that exits early can't pass for a run that finished.
if [ "$status" -eq 0 ] && [ "$(tail -n 1 "$work/results/checks.log" 2>/dev/null)" = "upgrade-test: passed" ]; then
	exit 0
fi
echo "upgrade-test: FAILED ($status)" >&2
exit 1
