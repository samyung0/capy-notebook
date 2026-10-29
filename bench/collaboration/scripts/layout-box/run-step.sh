#!/usr/bin/env bash
# One layout-cost stack step on a fresh stack in Compose project
# capy-capacity (the 2026-10-28 presence run's run-step.sh, note rooms only):
# up, seed, a 20 s idle baseline, the stress generators, logs, summary
# (summarize-L.mjs), teardown.
#
# Usage: run-step.sh <step name> <rooms>, with
#   LAYOUT   plate | blocks (the collaboration server's note layout)
#   NOTE     small (five paragraphs) | limit (the ~2 MB load-test note)
#   PEERS    typing peers per room (1), beside each room's watcher
#   EDIT_MS  mean ms between one peer's edits (100: 10 a second)
#   IDLE     true: the peers stay connected and never type
#   MINUTES  typing (or idle) minutes (3)
# No offline drops and no carets: the room's own cost only.
set -uo pipefail
NAME=$1 N=$2
LAYOUT=${LAYOUT:?plate or blocks} NOTE=${NOTE:-small} PEERS=${PEERS:-1}
EDIT_MS=${EDIT_MS:-100} IDLE=${IDLE:-false} MINUTES=${MINUTES:-3}
W=/root/capy-capacity
BOX=$(cd "$(dirname "$0")" && pwd)
SRC=$W/L/src
RUN=$W/runs/L-$NAME
if [ -e "$RUN" ]; then
  echo "$RUN exists" >&2
  exit 1
fi
mkdir -p "$RUN"/gen1 "$RUN"/gen2 "$RUN"/gen3 "$RUN"/gen4
exec > >(tee -a "$RUN/step.log") 2>&1
log() { echo "$(date -u +%FT%T.%3NZ) $*"; }

GENS=$((N < 4 ? N : 4))
EXPECTED=$((N * (PEERS + 1)))

export E2E_AUTH_SECRET SHARE_LINK_SECRET CAP_LAYOUT=$LAYOUT
E2E_AUTH_SECRET=$(openssl rand -hex 32)
SHARE_LINK_SECRET=$(openssl rand -hex 32)
export STRESS_FAKE_S3=$SRC/bench/collaboration/scripts/fake-s3.mjs
export STRESS_TLS_DIR=$W/tls-L
export CAP_GEN_ROOT=$W/L/gen CAP_STEP=$RUN
C=(docker compose -p capy-capacity
  -f "$SRC/deploy/docker-compose.e2e.yml"
  -f "$SRC/bench/collaboration/scripts/docker-compose.stress.yml"
  -f "$BOX/capacity-L.yml")

# The fake S3's throwaway certificate (CA:FALSE: rustls refuses a CA
# certificate as the server's own).
rm -rf "$STRESS_TLS_DIR"
mkdir -p "$STRESS_TLS_DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=s3.stress.backblazeb2.com \
  -addext subjectAltName=DNS:s3.stress.backblazeb2.com -addext basicConstraints=critical,CA:FALSE \
  -keyout "$STRESS_TLS_DIR/key.pem" -out "$STRESS_TLS_DIR/cert.pem" 2>/dev/null || exit 1
chmod 644 "$STRESS_TLS_DIR"/*.pem
chmod 755 "$STRESS_TLS_DIR"

for k in $(seq 1 $GENS); do
  rooms=$((N / GENS + (k <= N % GENS ? 1 : 0)))
  {
    echo STRESS_STACK=external
    echo E2E_API_URL=http://server:8080
    echo "E2E_AUTH_SECRET=$E2E_AUTH_SECRET"
    echo E2E_BASE_URL=http://127.0.0.1:5174
    echo STRESS_UPLOAD_ORIGIN=http://s3:9000
    echo STRESS_OUT=/out
    echo STRESS_KINDS=plate
    echo "STRESS_NOTE=$NOTE"
    echo "STRESS_ROOMS=$rooms"
    echo "STRESS_PEERS=$PEERS"
    echo "STRESS_EDIT_MS=$EDIT_MS"
    echo "STRESS_IDLE=$IDLE"
    echo "STRESS_MINUTES=$MINUTES"
    echo STRESS_DROP_PER_SECOND=0
    echo STRESS_CURSOR_HZ=0
    echo "STRESS_WORKSPACE=ws_cap_$k"
  } >"$RUN/gen$k.env"
done

teardown() {
  log "teardown"
  "${C[@]}" --profile gen --profile tools down -v --remove-orphans --timeout 15 >/dev/null 2>&1
}

log "step L-$NAME: $LAYOUT, $NOTE note, $N rooms of $PEERS peers, $GENS generators, $EXPECTED connections"
if ! "${C[@]}" up -d --wait --wait-timeout 300 --no-build --pull never db redis server collaboration s3; then
  log "stack did not come up"
  "${C[@]}" logs --no-color -t >"$RUN/stack-failed.log" 2>&1
  teardown
  exit 1
fi
"${C[@]}" exec -T db psql -q -U capy -d capy -v ON_ERROR_STOP=1 <"$SRC/e2e/fixtures/seed.sql" &&
  "${C[@]}" exec -T db psql -q -U capy -d capy -v ON_ERROR_STOP=1 <"$BOX/seed-extra.sql" || {
  log "seed failed"
  teardown
  exit 1
}

setsid "$BOX/monitor.sh" "$RUN" 2>"$RUN/monitor.err" &
log "baseline 20 s"
date +%s%3N >"$RUN/T-baseline"
sleep 20
GEN_NAMES=()
for k in $(seq 1 $GENS); do GEN_NAMES+=("gen$k"); done
log "generators up: ${GEN_NAMES[*]}"
date +%s%3N >"$RUN/T-generators"
"${C[@]}" --profile gen up -d --no-deps --no-build --pull never "${GEN_NAMES[@]}"

deadline=$(($(date +%s) + 30 * 60))
while :; do
  running=0
  for g in "${GEN_NAMES[@]}"; do
    [ "$(docker inspect -f '{{.State.Running}}' "capy-capacity-$g-1" 2>/dev/null)" = true ] && running=$((running + 1))
  done
  [ "$running" -eq 0 ] && break
  if [ -e "$RUN/ABORT" ]; then
    log "ABORT: $(cat "$RUN/ABORT")"
    sleep 5
    break
  fi
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "$(date -u +%FT%TZ) step timeout (30 min)" >"$RUN/ABORT"
    log "timeout, killing generators"
    for g in "${GEN_NAMES[@]}"; do docker kill "capy-capacity-$g-1" >/dev/null 2>&1; done
    break
  fi
  sleep 5
done
date +%s%3N >"$RUN/T-done"
log "generators done; 25 s for the last collab_health line"
sleep 25
touch "$RUN/STOP"

for g in "${GEN_NAMES[@]}"; do
  docker inspect "capy-capacity-$g-1" >"$RUN/$g.inspect.json" 2>&1
  docker logs "capy-capacity-$g-1" >"$RUN/$g.log" 2>&1
done
"${C[@]}" logs --no-color --no-log-prefix -t collaboration >"$RUN/collaboration.log" 2>&1
cat >"$RUN/meta.json" <<EOF
{
  "step": "$NAME",
  "layout": "$LAYOUT",
  "note": "$NOTE",
  "rooms": $N,
  "peers": $PEERS,
  "editMs": $EDIT_MS,
  "idle": $IDLE,
  "minutes": $MINUTES,
  "gens": $GENS,
  "expectedConnections": $EXPECTED,
  "sha": "$(cat "$W/L/SHA" 2>/dev/null)",
  "collaborationImage": "$(docker inspect -f '{{.Config.Image}} {{.Image}}' capy-capacity-collaboration-1 2>/dev/null)"
}
EOF
"${C[@]}" --profile tools run --rm --no-deps -T tools node /w/box-L/summarize-L.mjs "/w/runs/L-$NAME" </dev/null || log "summary failed"
teardown
left=$(docker ps -aq --filter label=com.docker.compose.project=capy-capacity | wc -l)
log "done: $(cat "$RUN/VERDICT" 2>/dev/null || echo no verdict); containers left $left"
