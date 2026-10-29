#!/usr/bin/env bash
# monitor.sh <run dir>: every 2 s until <run dir>/STOP exists, appends to
# <run dir>/monitor.tsv (epoch ms first):
#   C <service> <cpu usage_usec> <memory.current> <anon> <inactive_file>
#     for each container of Compose project capy-capacity (cgroup v2);
#   R collaboration <VmRSS kB summed over its processes> <process count>;
#   N collaboration <eth0 bytes received> <eth0 bytes sent>;
#   H <MemAvailable kB> <SwapFree kB> <pswpin> <pswpout> <load1> <per-CPU
#     "cpuN:busy:total:steal" jiffies>.
# Guard (TASK.md): when MemAvailable stays under 300 MiB with swap traffic
# over 1 MiB/s for two samples in a row, or the sampler itself stalls for
# 30 s, it writes <run dir>/ABORT and kills the load generators.
set -u
RUN=$1
PROJECT=capy-capacity
GUARD_AVAIL_KB=$((300 * 1024))
GUARD_SWAP_PAGES=512 # 4 KiB pages per 2 s sample: 1 MiB/s, in and out
strikes=0
prev_swap=
prev_at=

abort() {
  [ -e "$RUN/ABORT" ] && return
  echo "$(date -u +%FT%TZ) $1" >"$RUN/ABORT"
  docker ps --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}' |
    awk '$2 ~ /^gen/ {print $1}' | xargs -r docker kill >/dev/null 2>&1
}

while [ ! -e "$RUN/STOP" ]; do
  now=$(date +%s%3N)
  while read -r id service; do
    d=/sys/fs/cgroup/system.slice/docker-$id.scope
    [ -d "$d" ] || continue
    usage=$(awk '$1 == "usage_usec" {print $2}' "$d/cpu.stat" 2>/dev/null)
    current=$(cat "$d/memory.current" 2>/dev/null)
    read -r anon inactive < <(awk '$1 == "anon" {a = $2} $1 == "inactive_file" {i = $2} END {print a, i}' "$d/memory.stat" 2>/dev/null)
    [ -n "$usage" ] && printf '%s\tC\t%s\t%s\t%s\t%s\t%s\n' "$now" "$service" "$usage" "$current" "$anon" "$inactive"
    if [ "$service" = collaboration ]; then
      rss=0
      procs=0
      for pid in $(cat "$d/cgroup.procs" 2>/dev/null); do
        kb=$(awk '/^VmRSS/ {print $2}' "/proc/$pid/status" 2>/dev/null)
        rss=$((rss + ${kb:-0}))
        procs=$((procs + 1))
      done
      printf '%s\tR\tcollaboration\t%s\t%s\n' "$now" "$rss" "$procs"
      # Its network namespace's eth0 bytes received and sent.
      first=$(head -1 "$d/cgroup.procs" 2>/dev/null)
      read -r rx tx < <(awk '$1 == "eth0:" {print $2, $10}' "/proc/$first/net/dev" 2>/dev/null)
      [ -n "${tx:-}" ] && printf '%s\tN\tcollaboration\t%s\t%s\n' "$now" "$rx" "$tx"
    fi
  done < <(docker ps --no-trunc --filter "label=com.docker.compose.project=$PROJECT" \
    --format '{{.ID}} {{.Label "com.docker.compose.service"}}')
  avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  swapfree=$(awk '/^SwapFree:/ {print $2}' /proc/meminfo)
  read -r pin pout < <(awk '$1 == "pswpin" {i = $2} $1 == "pswpout" {o = $2} END {print i, o}' /proc/vmstat)
  cpus=$(awk '/^cpu[0-9]/ {b = $2 + $3 + $4 + $7 + $8 + $9; printf "%s:%s:%s:%s ", $1, b, b + $5 + $6, $9}' /proc/stat)
  printf '%s\tH\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$avail" "$swapfree" "$pin" "$pout" "$(cut -d' ' -f1 /proc/loadavg)" "$cpus"

  swap=$((pin + pout))
  if [ -n "$prev_swap" ]; then
    if [ "$avail" -lt "$GUARD_AVAIL_KB" ] && [ $((swap - prev_swap)) -gt "$GUARD_SWAP_PAGES" ]; then
      strikes=$((strikes + 1))
    else
      strikes=0
    fi
    [ "$strikes" -ge 2 ] && abort "memory guard: MemAvailable ${avail} kB, swap $((swap - prev_swap)) pages in 2 s"
  fi
  if [ -n "$prev_at" ] && [ $((now - prev_at)) -gt 30000 ]; then
    abort "sampler stalled $((now - prev_at)) ms"
  fi
  prev_swap=$swap
  prev_at=$now
  sleep 2
done >>"$RUN/monitor.tsv"
