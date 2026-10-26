#!/usr/bin/env bash
# One ladder step on the bench host: samples the containers while the
# generator runs <users> sessions for the ramp plus the measured time, then
# keeps the gateway's pool-wait lines and its warnings and errors. Arguments
# after the duration go to the generator's run; STEP_TAG names the variant.
set -euo pipefail
users=${1:?usage: step.sh <users> [ramp] [duration] [run args...]}
ramp=${2:-2m}
duration=${3:-5m}
shift $(($# < 3 ? $# : 3))
cd "$(dirname "$0")"
name=users-$users${STEP_TAG:+-$STEP_TAG}-$(date +%m%d-%H%M)
out=../.results/$name
mkdir -p "$out"
since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
./sample.sh "$out" &
sampler=$!
trap 'kill $sampler 2>/dev/null || true' EXIT
docker compose exec -T loadgen /loadgen run -users "$users" -ramp "$ramp" -duration "$duration" \
	-name "$name/summary" "$@" 2>&1 | tee "$out/summary.txt"
docker compose logs server --since "$since" --no-log-prefix >"$out/server.log" 2>&1
grep '"db pool waits"' "$out/server.log" >"$out/pool-waits.jsonl" || true
grep -E '"level":"(WARN|ERROR)"' "$out/server.log" >"$out/server-problems.jsonl" || true
# The access log is most of the file and is summarized by the generator.
rm "$out/server.log"
echo "pool-wait windows: $(wc -l <"$out/pool-waits.jsonl"), warnings and errors: $(wc -l <"$out/server-problems.jsonl")"
