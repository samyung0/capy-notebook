#!/usr/bin/env bash
# A note room's server CPU and memory in the Plate and the blocks layout, same
# content, per editing state (layout-cost/src/main.rs). Local, no Docker:
# builds on the collaboration server's crates and model.rs with its
# Cargo.lock, and prints one JSON line per note, layout and state to stdout and
# bench/collaboration/.results/layout-cost.jsonl. SCALE (1), ROOMS (20), RUNS
# (5), NOTES, LAYOUTS and STATES pass through; the prod box run is
# layout-box/README.md.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../../.." && pwd)"
results="$root/bench/collaboration/.results"
mkdir -p "$results"
cp "$root/collaboration-rs/Cargo.lock" "$here/layout-cost/Cargo.lock"
(cd "$root" && node_modules/.bin/tsx bench/collaboration/scripts/layout-values.ts "$results/layout-values.json")
cargo run --release --quiet --manifest-path "$here/layout-cost/Cargo.toml" -- \
  "$results/layout-values.json" | tee "$results/layout-cost.jsonl"
