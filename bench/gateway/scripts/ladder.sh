#!/usr/bin/env bash
# Runs step.sh for each user count in turn with the same ramp and duration,
# stopping after the first step that fails the pass rule. Arguments after --
# go to every step's generator run (e.g. -skip "GET /api/materials").
set -euo pipefail
ramp=${RAMP:-2m}
duration=${DURATION:-5m}
cd "$(dirname "$0")"
counts=()
while [ $# -gt 0 ] && [ "$1" != "--" ]; do
	counts+=("$1")
	shift
done
[ $# -gt 0 ] && shift
for users in "${counts[@]}"; do
	./step.sh "$users" "$ramp" "$duration" "$@" | tee /dev/stderr | grep " → PASS" >/dev/null || {
		echo "stopped at $users users"
		exit 0
	}
	# Let idle connections and Postgres settle between steps.
	sleep 20
done
