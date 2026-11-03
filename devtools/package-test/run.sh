#!/bin/bash
# Installs, upgrades and removes the .deb and RPM in throwaway containers that boot systemd.
# See README.md.
#
#   devtools/package-test/run.sh [image...]     no arguments runs every image below
#
# Exits 0 if every image passed.
set -uo pipefail

IMAGES=(debian:12 ubuntu:24.04 almalinux:9 fedora:42)
DEADLINE_SECONDS=900

command -v docker >/dev/null || { echo "package-test: docker is required" >&2; exit 100; }
command -v go >/dev/null || { echo "package-test: go is required" >&2; exit 100; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 100
[ $# -gt 0 ] || set -- "${IMAGES[@]}"

work=$(mktemp -d) || exit 100
trap 'rm -rf "$work"' EXIT
mkdir "$work/pkg" || exit 100
chmod 755 "$work" "$work/pkg"

arch=$(go env GOARCH)
for version in 0.0.1 0.0.2; do
	CGO_ENABLED=0 go build -trimpath -ldflags "-X main.version=$version" \
		-o "$work/pkg/evuproxy-$version-linux-$arch" ./cmd/evuproxy || { echo "package-test: go build failed" >&2; exit 100; }
	./scripts/build-packages.sh "$version" "$work/pkg" "$arch" || { echo "package-test: packaging failed" >&2; exit 100; }
done

failed=0
for image in "$@"; do
	echo "=== $image"
	results=$(mktemp -d -p "$work") || exit 100
	chmod 777 "$results"
	name="evuproxy-package-test-$$-${image//[:\/]/-}"
	# systemd as PID 1 needs a writable cgroup tree, which Docker only gives a privileged
	# container. The network namespace stays the container's own, so the firewall checks and
	# their rules never reach this host. Nothing is published, and --rm removes all of it.
	timeout -k 10 "$DEADLINE_SECONDS" docker run --rm --name "$name" \
		--privileged --cgroupns=private --tmpfs /run --tmpfs /run/lock --tmpfs /tmp \
		-e container=docker \
		-v "$PWD/devtools/package-test:/test:ro" -v "$work/pkg:/pkg:ro" -v "$results:/results" \
		"$image" bash /test/entry.sh >"$results/docker.log" 2>&1
	status=$?
	if [ "$status" -eq 124 ] || [ "$status" -eq 137 ]; then
		echo "package-test: $image hit the ${DEADLINE_SECONDS}s deadline" >&2
		docker kill "$name" >/dev/null 2>&1
	fi
	if [ -f "$results/checks.log" ]; then
		cat "$results/checks.log"
	else
		cat "$results/docker.log"
	fi
	# Both, so a systemd that exits early can't pass for a run that finished.
	if [ "$status" -eq 0 ] && [ "$(tail -n 1 "$results/checks.log" 2>/dev/null)" = "package-test: passed" ]; then
		echo "package-test: $image passed"
	else
		echo "package-test: $image FAILED ($status)" >&2
		failed=$((failed + 1))
	fi
done

if [ "$failed" -gt 0 ]; then
	echo "package-test: $failed image(s) failed" >&2
	exit 1
fi
echo "package-test: passed"
