#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-fast}"
cd "$REVIEW_ROOT"

fast_commands=(
  "pnpm run check"
  "pnpm review:validate-boundaries"
  "pnpm test"
  "pnpm --filter @evo-notes/ops test"
  "pnpm test:collaboration"
  "pnpm test:import-relay"
  "pnpm test:pipeline:offline"
)
full_commands=(
  "pnpm test:go"
  "pnpm test:pipeline"
  "pnpm e2e"
  "pnpm e2e:editor"
  "pnpm perf"
)

if [[ "$mode" == "--list" ]]; then
  printf '%s\n' "${fast_commands[@]}" "${full_commands[@]}"
  exit 0
fi

[[ "$mode" == "fast" || "$mode" == "full" ]] ||
  review_die "use fast, full, or --list"

run_command() {
  local command="$1"
  printf '\n==> %s\n' "$command"
  bash -lc "$command"
}

for command in "${fast_commands[@]}"; do
  run_command "$command"
done

if [[ "$mode" == "full" ]]; then
  for command in "${full_commands[@]}"; do
    run_command "$command"
  done
fi
