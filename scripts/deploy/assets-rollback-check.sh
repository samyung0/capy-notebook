#!/usr/bin/env bash
# Whether a failed SPA Worker deploy may roll the assets Worker back
# (human/deployment-runbook.md, 2026-10-17): reads the app host's
# /release.txt up to 3 times over about 30 s and exits 0, roll back, only when
# a read succeeded and every successful read showed the old revision. A read
# showing DEPLOY_REVISION (its index.html needs the new assets), or no
# successful read, exits 1 for the manual rollback of both Workers.

set -euo pipefail

manual() {
  printf '::error::%s: no automatic rollback; roll back both Workers by hand (deployment-runbook §1)\n' "$1" >&2
  exit 1
}

[[ "${DEPLOY_REVISION:-}" =~ ^[0-9a-fA-F]{40}$ ]] || manual "DEPLOY_REVISION must be a full 40-character Git SHA"
[[ -n "${DEPLOYMENT_APP_URL:-}" ]] || manual "DEPLOYMENT_APP_URL is required"

release="${DEPLOYMENT_APP_URL%/}/release.txt"
reads=0
for attempt in 1 2 3; do
  ((attempt == 1)) || sleep 15
  # A failed request, an error status or a body that is no revision is no read.
  served="$(curl -fsS --max-time 10 "$release")" || continue
  served="${served//[[:space:]]/}"
  [[ "$served" =~ ^[0-9a-fA-F]{40}$ ]] || continue
  [[ "$served" != "$DEPLOY_REVISION" ]] || manual "The app host already serves $DEPLOY_REVISION"
  reads=$((reads + 1))
  printf 'Read %s: the app host serves %s\n' "$attempt" "$served"
done
((reads > 0)) || manual "No read of $release succeeded"
printf 'Every read showed the previous release: rolling the assets Worker back\n'
