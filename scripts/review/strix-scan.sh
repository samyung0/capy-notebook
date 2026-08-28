#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

scope="${1:-source}"
mode="${2:-standard}"
budget="${3:-${STRIX_MAX_BUDGET:-40}}"

review_load_env
review_require_command strix
review_require_value STRIX_LLM
review_require_value LLM_API_KEY
[[ "$mode" == "quick" || "$mode" == "standard" || "$mode" == "deep" ]] ||
  review_die "scan mode must be quick, standard, or deep"
[[ "$budget" =~ ^[0-9]+([.][0-9]+)?$ ]] || review_die "budget must be numeric"

cd "$REVIEW_ROOT"
results="$(review_results_dir "strix-$scope")"
mkdir -p "$results"
instruction_file=""
temporary_instruction_file=""

cleanup() {
  # Invoked by the EXIT trap.
  # shellcheck disable=SC2317
  [[ -z "$temporary_instruction_file" ]] || rm -f "$temporary_instruction_file"
}
trap cleanup EXIT

targets=(-t .)
case "$scope" in
  source)
    instruction_file="$REVIEW_ROOT/review/strix-source.md"
    ;;
  uat)
    review_require_authorized_uat
    temporary_instruction_file="$(mktemp "${TMPDIR:-/tmp}/evo-strix-instructions.XXXXXX")"
    instruction_file="$temporary_instruction_file"
    chmod 600 "$instruction_file"
    cp "$REVIEW_ROOT/review/strix-uat.md" "$instruction_file"
    if [[ -n "${STRIX_UAT_AUTH_INSTRUCTIONS:-}" ]]; then
      printf '\n## Synthetic authentication instructions\n\n%s\n' \
        "$STRIX_UAT_AUTH_INSTRUCTIONS" >> "$instruction_file"
    fi
    targets+=(-t "$UAT_APP_URL" -t "$UAT_API_URL" -t "$REVIEW_ROOT/openapi.yaml")
    ;;
  *)
    review_die "scope must be source or uat"
    ;;
esac

scan_started_at="$(node -e 'process.stdout.write(String(Date.now()))')"
set +e
strix -n "${targets[@]}" --scan-mode "$mode" --scope-mode full \
  --instruction-file "$instruction_file" --max-budget "$budget"
status=$?
set -e

printf '%s\n' "$status" > "$results/strix-exit-code.txt"
printf '%s\n' "$budget" > "$results/strix-max-budget.txt"
if latest="$(node "$SCRIPT_DIR/latest-strix-run.mjs" "$REVIEW_ROOT/strix_runs" "$scan_started_at")"; then
  cp -R "$latest"/. "$results"/
fi
printf '%s\n' "$results" > "$REVIEW_ROOT/review-results/latest-strix-result.txt"
printf 'Strix results: %s\n' "$results"
exit "$status"
