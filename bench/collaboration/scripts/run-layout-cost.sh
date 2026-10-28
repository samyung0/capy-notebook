#!/usr/bin/env bash
# A note room's server costs in the Plate and the blocks layout, same content
# (layout-cost/src/main.rs). Local, no Docker: builds on the collaboration
# server's crates with its Cargo.lock, and prints one JSON line per note and
# layout to stdout and bench/collaboration/.results/layout-cost.jsonl.
# RUNS (5) sets the repeats per step.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
results="$root/bench/collaboration/.results"
mkdir -p "$results"
cp "$root/collaboration-rs/Cargo.lock" "$here/layout-cost/Cargo.lock"
(cd "$root" && node_modules/.bin/tsx bench/collaboration/scripts/layout-values.ts "$results/layout-values.json")
cargo run --release --quiet --manifest-path "$here/layout-cost/Cargo.toml" -- \
  "$results/layout-values.json" | tee "$results/layout-cost.jsonl"
