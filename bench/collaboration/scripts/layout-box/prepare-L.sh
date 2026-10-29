#!/usr/bin/env bash
# Layout-cost box run, staging on the Mac (README.md here; todo-blocksuite-spike.md
# D9): the blocksuite-notes branch (the server under test; one image runs both
# layouts, COLLABORATION_DOCUMENT_LAYOUT picks one per step) with this
# checkout's bench/collaboration/scripts laid over it (the matrix and
# stress.ts's blocks typing, uncommitted until they land), the BetterOffice
# fork at the branch's pin, the stress generator bundle and the matrix's note
# values. With --upload, sends them to /root/capy-capacity/L and this folder
# to /root/capy-capacity/box-L on the prod box. Nothing runs there: build-L.sh,
# run-matrix.sh and ladder.sh are started by hand after Epo was told.
#
# Usage: prepare-L.sh <stage dir> [--upload]   (CAP_REF: the ref, blocksuite-notes)
set -euo pipefail
STAGE=${1:?stage dir}
HERE=$(cd "$(dirname "$0")" && pwd)
CAPY=$(cd "$HERE/../../../.." && pwd)
REF=${CAP_REF:-blocksuite-notes}
ESBUILD=$CAPY/node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild
KEY="-i $HOME/.ssh/id_ed25519_capy_prod -o BatchMode=yes -o ConnectTimeout=20"
BOX=root@49.12.219.255

SHA=$(git -C "$CAPY" rev-parse "$REF")
PIN=$(git -C "$CAPY" ls-tree "$SHA" vendor/betteroffice | awk '{print $3}')
echo "capy $REF $SHA, betteroffice pin $PIN"

rm -rf "$STAGE"
mkdir -p "$STAGE/src/vendor/betteroffice" "$STAGE/gen/bench/collaboration/scripts"
echo "$SHA" >"$STAGE/SHA"
echo "$PIN" >"$STAGE/VENDOR_SHA"
git -C "$CAPY" archive --format=tar "$SHA" \
  .dockerignore package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json patches src server \
  collaboration-rs deploy/docker-compose.e2e.yml bench/collaboration/scripts \
  e2e/global-setup.ts e2e/global-teardown.ts e2e/fixtures/seed.sql | tar -C "$STAGE/src" -xf -
# This checkout's bench scripts over the branch's; their hashes say which ran.
rsync -a --delete --exclude target --exclude .results \
  "$CAPY/bench/collaboration/scripts/" "$STAGE/src/bench/collaboration/scripts/"
(cd "$STAGE/src" && find bench/collaboration/scripts -type f | sort | xargs shasum -a 256) >"$STAGE/scripts.sha256"
git -C "$CAPY/vendor/betteroffice" cat-file -e "$PIN^{commit}"
git -C "$CAPY/vendor/betteroffice" archive --format=tar "$PIN" | tar -C "$STAGE/src/vendor/betteroffice" -xf -

# The matrix's notes (near-limit load-test, common subset, small), as the app
# normalizes them; baked into its image.
(cd "$CAPY" && node_modules/.bin/tsx bench/collaboration/scripts/layout-values.ts \
  "$STAGE/src/bench/collaboration/scripts/layout-box/layout-values.json")

node "$HERE/bundle.mjs" "$ESBUILD" "$STAGE/src" "$CAPY/node_modules" \
  "$STAGE/gen/bench/collaboration/scripts/stress.bundle.mjs" \
  "$STAGE/src/collaboration-rs/crates/notes/markdown/i18n-stub.mjs"
du -sh "$STAGE/src" "$STAGE/gen"

if [ "${2:-}" = --upload ]; then
  # The box's image inventory before anything of a capacity run exists:
  # cleanup.sh keeps every image listed there.
  ssh $KEY $BOX 'mkdir -p /root/capy-capacity/L /root/capy-capacity/box-L /root/capy-capacity/runs &&
    [ -e /root/capy-capacity/baseline-images.txt ] ||
    docker images --no-trunc --format "{{.Repository}}:{{.Tag}} {{.ID}}" >/root/capy-capacity/baseline-images.txt;
    cat /root/capy-capacity/baseline-images.txt; docker buildx du | tail -1; free -m; nproc'
  (cd "$STAGE" && COPYFILE_DISABLE=1 tar -cf - src gen SHA VENDOR_SHA scripts.sha256) | ssh $KEY $BOX 'tar -C /root/capy-capacity/L -xf -'
  (cd "$HERE" && COPYFILE_DISABLE=1 tar -cf - --exclude layout-values.json .) |
    ssh $KEY $BOX 'tar -C /root/capy-capacity/box-L -xf - && chown -R root:root /root/capy-capacity && chmod +x /root/capy-capacity/box-L/*.sh'
fi
