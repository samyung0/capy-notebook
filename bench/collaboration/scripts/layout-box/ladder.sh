#!/usr/bin/env bash
# ladder.sh <plan file> [first step]: the 2026-10-28 presence run's ladder for
# the layout-cost steps. Runs the plan's lines "<group> <step name> <rooms>
# [VAR=value ...]" in order (the variables, e.g. LAYOUT=blocks, go to
# run-step.sh), each with run-step.sh on a fresh stack. After a step whose
# VERDICT is `fail` or `abort` the rest of its group is skipped. Waits for
# the box to return to at least 5 GiB available memory before each step.
set -uo pipefail
PHASE=L PLAN=$1 FROM=${2:-}
W=/root/capy-capacity
BOX=$(cd "$(dirname "$0")" && pwd)
skip=""
started=${FROM:+no}
while read -r group name n extra; do
  [ -z "${group:-}" ] && continue
  case $group in \#*) continue ;; esac
  if [ "${started:-yes}" = no ]; then
    [ "$name" = "$FROM" ] || continue
    started=yes
  fi
  if [ "$group" = "$skip" ]; then
    echo "$(date -u +%FT%TZ) skip $name (group $group stopped)" | tee -a "$W/runs/ladder-$PHASE.log"
    continue
  fi
  for _ in $(seq 1 60); do
    [ "$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)" -ge $((5 * 1024 * 1024)) ] && break
    sleep 10
  done
  echo "$(date -u +%FT%TZ) start $name" | tee -a "$W/runs/ladder-$PHASE.log"
  # shellcheck disable=SC2086 # extra is a list of VAR=value words
  env ${extra:-} "$BOX/run-step.sh" "$name" "$n" </dev/null >/dev/null 2>&1
  verdict=$(cat "$W/runs/$PHASE-$name/VERDICT" 2>/dev/null || echo "no-verdict")
  echo "$(date -u +%FT%TZ) end $name: $verdict" | tee -a "$W/runs/ladder-$PHASE.log"
  case $verdict in fail* | abort*) skip=$group ;; esac
done <"$PLAN"
echo "$(date -u +%FT%TZ) ladder done" | tee -a "$W/runs/ladder-$PHASE.log"
touch "$W/runs/ladder-$PHASE.done"
