#!/usr/bin/env bash
# Run a source-aware Strix pentest against the authorized UAT deployment, then
# post the result as the `uat/strix` commit status on the SHA UAT is serving.
# Usage: strix-scan.sh [quick|standard|deep] [budget-usd]

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-standard}"
budget="${2:-${STRIX_MAX_BUDGET:-40}}"

review_load_env
review_require_command strix
review_require_command curl
review_require_value STRIX_LLM
review_require_value LLM_API_KEY
review_require_authorized_uat
[[ "$mode" == "quick" || "$mode" == "standard" || "$mode" == "deep" ]] ||
  review_die "scan mode must be quick, standard, or deep"
[[ "$budget" =~ ^[0-9]+([.][0-9]+)?$ ]] || review_die "budget must be numeric"

# The status must land on the revision the deployment is actually serving, not
# on whatever the local checkout happens to be.
deployed_sha="$(curl --silent --show-error --max-time 30 --head "${UAT_API_URL%/}/healthz" |
  awk 'BEGIN { IGNORECASE=1 } /^x-evo-release:/ { sub(/^[^:]+:[[:space:]]*/, ""); sub(/\r$/, ""); print; exit }')"
[[ "$deployed_sha" =~ ^[0-9a-fA-F]{40}$ ]] ||
  review_die "UAT gateway did not report a full X-Evo-Release SHA (got '${deployed_sha:-nothing}')"

cd "$REVIEW_ROOT"
results="$(review_results_dir strix-uat)"
mkdir -p "$results"
instruction_file="$(mktemp "${TMPDIR:-/tmp}/evo-strix-instructions.XXXXXX")"
trap 'rm -f "$instruction_file"' EXIT
chmod 600 "$instruction_file"
cp "$REVIEW_ROOT/review/strix-uat.md" "$instruction_file"
if [[ -n "${STRIX_UAT_AUTH_INSTRUCTIONS:-}" ]]; then
  printf '\n## Synthetic authentication instructions\n\n%s\n' \
    "$STRIX_UAT_AUTH_INSTRUCTIONS" >> "$instruction_file"
fi

scan_started_at="$(node -e 'process.stdout.write(String(Date.now()))')"
set +e
strix -n -t . -t "$UAT_APP_URL" -t "$UAT_API_URL" -t "$REVIEW_ROOT/openapi.yaml" \
  --scan-mode "$mode" --scope-mode full \
  --instruction-file "$instruction_file" --max-budget "$budget"
status=$?
set -e

printf '%s\n' "$status" > "$results/strix-exit-code.txt"
printf '%s\n' "$budget" > "$results/strix-max-budget.txt"
printf '%s\n' "$deployed_sha" > "$results/revision.txt"
if latest="$(node "$SCRIPT_DIR/latest-strix-run.mjs" "$REVIEW_ROOT/strix_runs" "$scan_started_at")"; then
  cp -R "$latest"/. "$results"/
fi
printf '%s\n' "$results" > "$REVIEW_ROOT/review-results/latest-strix-result.txt"

set +e
node "$SCRIPT_DIR/validate-strix-run.mjs" "$results" --enforce-findings
verdict=$?
set -e
state=failure
((verdict != 0)) || state=success
description="strix $mode: $(cat "$results/status-description.txt" 2>/dev/null || printf 'validation did not run')"
"$SCRIPT_DIR/report-status.sh" uat/strix "$state" "$description" "$deployed_sha"
printf 'Strix results: %s\n' "$results"
exit "$verdict"
