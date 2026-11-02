#!/bin/bash
# Entry point inside the container, started by run.sh. Never run this directly: it refuses
# anywhere but a disposable container, before it changes anything.
set -uo pipefail

E2E_DIR=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=devtools/e2e/harness.sh
. "$E2E_DIR/harness.sh"

refuse_unless_disposable

scenarios=("$@")
if [ "${#scenarios[@]}" -eq 0 ]; then
	for f in "$E2E_DIR"/scenarios/*.sh; do
		scenarios+=("$(basename "$f" .sh)")
	done
fi
for s in "${scenarios[@]}"; do
	[ -f "$E2E_DIR/scenarios/$s.sh" ] || die "no such scenario: $s"
done

install_tools
trap 'topology_down' EXIT
trap 'exit 100' INT TERM

for s in "${scenarios[@]}"; do
	log "##### scenario: $s"
	topology_up
	# shellcheck source=/dev/null
	. "$E2E_DIR/scenarios/$s.sh"
	[ "$failures" -eq 0 ] || dump_diagnostics
	check "firewall rules stayed inside the namespaces" runner_namespace_untouched
	topology_down
done

log "$checks checks, $failures failed"
[ "$failures" -le 99 ] || failures=99
exit "$failures"
