#!/usr/bin/env bash
# Samples the bench containers once a second until killed, on the host (cgroup
# v2 under systemd): CPU as a share of one core and resident memory per
# container into containers.csv, Postgres backends by state and wait type into
# postgres.csv.
set -euo pipefail
out=${1:?usage: sample.sh <results dir>}
mkdir -p "$out"
project=capy-gwbench
services=(server db redis loadgen)

declare -A cg last
for s in "${services[@]}"; do
	id=$(docker inspect -f '{{.Id}}' "$project-$s-1")
	cg[$s]=/sys/fs/cgroup/system.slice/docker-$id.scope
	last[$s]=$(awk '/^usage_usec/ {print $2}' "${cg[$s]}/cpu.stat")
done

echo "time,service,cpu_cores,memory_mib" >"$out/containers.csv"
echo "time,state,wait_event_type,backends" >"$out/postgres.csv"
# Each core's busy share too, which shows work outside the containers
# (dockerd writing the access log, network interrupts) landing on a pinned core.
echo "time,core,busy" >"$out/cores.csv"
cores() { awk '/^cpu[0-9]/ {print $1, $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat; }
declare -A busy total
while read -r core b t; do busy[$core]=$b total[$core]=$t; done < <(cores)
prev=$(date +%s%N)
while sleep 1; do
	while read -r core b t; do
		awk -v t="$(date +%s)" -v c="$core" -v b=$((b - busy[$core])) -v d=$((t - total[$core])) \
			'BEGIN {printf "%s,%s,%.3f\n", t, c, d ? b / d : 0}' >>"$out/cores.csv"
		busy[$core]=$b total[$core]=$t
	done < <(cores)
	now=$(date +%s%N)
	elapsed_us=$(((now - prev) / 1000))
	prev=$now
	t=$(date +%s)
	for s in "${services[@]}"; do
		usage=$(awk '/^usage_usec/ {print $2}' "${cg[$s]}/cpu.stat")
		mem=$(cat "${cg[$s]}/memory.current")
		awk -v t="$t" -v s="$s" -v d=$((usage - last[$s])) -v e="$elapsed_us" -v m="$mem" \
			'BEGIN {printf "%s,%s,%.3f,%.1f\n", t, s, d / e, m / 1048576}' >>"$out/containers.csv"
		last[$s]=$usage
	done
	docker exec "$project-db-1" psql -U capy -d capy -At -F, -c \
		"SELECT $t, state, coalesce(wait_event_type, ''), count(*) FROM pg_stat_activity
		 WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()
		 GROUP BY 2, 3" >>"$out/postgres.csv" || true
done
