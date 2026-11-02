#!/bin/bash
# Runs the end-to-end scenarios in a throwaway container: real WireGuard and nftables, each
# "host" in its own network namespace inside that container. See README.md.
#
#   devtools/e2e/run.sh [scenario...]     no arguments runs every scenario
#
# Exits with the number of failed checks (at most 99), or 100 if it could not run at all.
set -uo pipefail

IMAGE=debian:12-slim
DEADLINE_SECONDS=900

refuse() {
	echo "e2e: REFUSING TO RUN: $*" >&2
	echo "e2e: this test changes firewall rules. Run it on a CI runner or a development machine." >&2
	exit 100
}

# No override on purpose. The namespaces keep the rules off this host, but a production host
# has no reason to be running this at all.
for marker in /etc/evuproxy/config.yaml /etc/wireguard/evuproxy0.conf /sys/class/net/evuproxy0 /etc/systemd/system/evuproxy.service; do
	[ ! -e "$marker" ] || refuse "this looks like an EvuProxy host: $marker exists"
done

command -v docker >/dev/null || { echo "e2e: docker is required" >&2; exit 100; }
command -v go >/dev/null || { echo "e2e: go is required" >&2; exit 100; }

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 100

bin_dir=$(mktemp -d) || exit 100
trap 'rm -rf "$bin_dir"' EXIT
CGO_ENABLED=0 go build -trimpath -o "$bin_dir/evuproxy" ./cmd/evuproxy || { echo "e2e: go build failed" >&2; exit 100; }

# NET_ADMIN and SYS_ADMIN apply to the container's own namespaces: creating more of them,
# mounting inside them, and loading rules into them. AppArmor's Docker profile denies mounts,
# which `ip netns` needs. Nothing is published, and --rm removes all of it afterwards.
docker run --rm \
	--cap-add NET_ADMIN --cap-add SYS_ADMIN --security-opt apparmor=unconfined \
	-e EVUPROXY_E2E_DISPOSABLE=1 \
	-v "$PWD/devtools/e2e:/e2e:ro" -v "$PWD/scripts:/scripts:ro" -v "$bin_dir:/e2e-bin:ro" \
	"$IMAGE" timeout -k 5 "$DEADLINE_SECONDS" bash /e2e/inside.sh "$@"
status=$?
case $status in
0) echo "e2e: passed" ;;
124 | 137) echo "e2e: hit the ${DEADLINE_SECONDS}s deadline" >&2; status=100 ;;
100) echo "e2e: could not run, see above" >&2 ;;
# Docker's and timeout's own errors, such as an image that can't be pulled. Not failed checks.
125 | 126 | 127) echo "e2e: could not start the container ($status)" >&2; status=100 ;;
*) echo "e2e: FAILED ($status)" >&2 ;;
esac
exit "$status"
