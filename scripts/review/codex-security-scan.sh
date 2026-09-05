#!/usr/bin/env bash
# Run a Codex Security scan of the clean checkout through the Codex CLI, copy
# the canonical artifacts under review-results/, and post `source/codex-security`
# on HEAD. Usage: codex-security-scan.sh [standard|deep]
# `deep` repeats independent Standard scans for hours; reserve it for release.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/review/common.sh
source "$SCRIPT_DIR/common.sh"

mode="${1:-standard}"
[[ "$mode" == "standard" || "$mode" == "deep" ]] || review_die "mode must be standard or deep"
review_require_command codex
review_require_command git

cd "$REVIEW_ROOT"
# A status on HEAD would claim evidence for code the scan never saw.
[[ -z "$(git status --porcelain)" ]] || review_die "worktree is dirty; commit or stash before a source scan"
sha="$(git rev-parse HEAD)"

results="$(review_results_dir codex-security)"
mkdir -p "$results"
last_message="$results/last-message.txt"
skill="security-scan"
[[ "$mode" != "deep" ]] || skill="deep-security-scan"

prompt="Use \$codex-security:$skill on this repository root with scope \".\". Treat SECURITY.md as the threat model. Do not modify any repository file. After completion, when report.md exists, end your final message with exactly one line of the form SCAN_DIR=<absolute path of the scan directory>."

set +e
codex exec --sandbox workspace-write --color never \
  --output-last-message "$last_message" -C "$REVIEW_ROOT" "$prompt"
codex_status=$?
set -e
printf '%s\n' "$codex_status" > "$results/codex-exit-code.txt"
printf '%s\n' "$sha" > "$results/revision.txt"

scan_dir="$(sed -n 's/^SCAN_DIR=\(.*\)$/\1/p' "$last_message" 2>/dev/null | tail -n 1)"
if [[ -z "$scan_dir" || ! -d "$scan_dir" ]]; then
  # Prompt-only scans land under the platform temp dir; take the newest one.
  scans_root="${TMPDIR:-/tmp}/codex-security-scans/$(basename "$REVIEW_ROOT")"
  scan_dir="$(ls -1dt "$scans_root"/*/ 2>/dev/null | head -n 1 || true)"
fi
if [[ -n "$scan_dir" && -d "$scan_dir" ]]; then
  for artifact in scan-manifest.json findings.json coverage.json report.md; do
    [[ ! -f "$scan_dir/$artifact" ]] || cp "$scan_dir/$artifact" "$results/"
  done
fi

set +e
node "$SCRIPT_DIR/validate-codex-scan.mjs" "$results"
verdict=$?
set -e
state=failure
((verdict != 0)) || state=success
description="codex-security $mode: $(cat "$results/status-description.txt" 2>/dev/null || printf 'validation did not run')"
"$SCRIPT_DIR/report-status.sh" source/codex-security "$state" "$description" "$sha"
printf 'Codex Security results: %s\n' "$results"
exit "$verdict"
