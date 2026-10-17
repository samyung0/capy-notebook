#!/usr/bin/env bash
# Builds what the recorder needs, under the machine-wide heavy lock
# (capy-harness session3/COMMON.md): the native check binary, then the fork's
# docx/xlsx/pptx wasm (fingerprinted, a no-op when current), its editor CSS
# and the shared office-checkpoint bundle. Logs go to $LOGS.
set -u
WT=C:/WEB/capy-worktrees/effects-recorder
LOGS=${LOGS:-C:/WEB/capy-harness/2026-10-17-effects-misses/logs}
L=C:/WEB/capy-harness/2026-10-06-rust-round/session3/heavy.lock
TAG="effects-recorder"
mkdir -p "$LOGS"
free_kb() { powershell -NoProfile -c '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory' | tr -d ''; }
# Take the lock only with 8 GB free (COMMON.md), waiting our turn.
until [ "$(free_kb)" -ge 8000000 ] && mkdir "$L" 2>/dev/null; do sleep 60; done
echo "$TAG native check build + fork build:wasm docx/xlsx/pptx $(date -Iseconds)" > "$L/owner"
release() { grep -q "^$TAG " "$L/owner" 2>/dev/null && rm -rf "$L"; }
trap release EXIT
export CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0
export PATH=/c/WEB/capy-tools/bun-1.3.14/node_modules/.bin:$PATH
status=0
( cd "$WT/bench/collaboration/scripts/effects-recorder/check" && time cargo build --release ) > "$LOGS/b-native-build.log" 2>&1 || status=1
echo "native=$status" > "$LOGS/b-build-status.txt"
cd "$WT/vendor/betteroffice"
for step in build:docx-wasm build:xlsx-wasm build:pptx-wasm; do
  ( time bun run $step ) > "$LOGS/b-$step.log" 2>&1 || { status=1; echo "$step failed" >> "$LOGS/b-build-status.txt"; }
done
( bun run --filter @betteroffice/docx-react build:css && bun scripts/build-office-checkpoint.ts ) > "$LOGS/b-css-checkpoint.log" 2>&1 || { status=1; echo "css/checkpoint failed" >> "$LOGS/b-build-status.txt"; }
echo "done status=$status $(date -Iseconds)" >> "$LOGS/b-build-status.txt"
exit $status
