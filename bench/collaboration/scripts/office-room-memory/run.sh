#!/usr/bin/env bash
# Runs the bench on the report's five fixtures, one JSON record and one
# /usr/bin/time record each. Run from the repository root with the
# vendor/betteroffice submodule checked out at its pin.
#
#   bench/collaboration/scripts/office-room-memory/run.sh <out-dir> [edits] [checkpoints]
set -euo pipefail
out=$1
edits=${2:-10000}
checkpoints=${3:-1000,10000}
here=$(dirname "$0")
target=${CARGO_TARGET_DIR:-$here/target}
CARGO_TARGET_DIR=$target cargo build --release --manifest-path "$here/Cargo.toml"
bin=$target/release/office-room-memory
case $(uname) in Darwin) time_flag=-l ;; *) time_flag=-v ;; esac
mkdir -p "$out"
while read -r format file name; do
  /usr/bin/time "$time_flag" "$bin" "$format" "$file" "$edits" "$checkpoints" \
    >"$out/$name.json" 2>"$out/$name.time.txt"
  echo "$name done"
done <<'EOF'
docx bench/editor/fixtures/office/long-handbook.docx long-handbook
docx vendor/betteroffice/poc/fixtures/book-30p.docx book-30p
docx vendor/betteroffice/poc/fixtures/exchange-plan.docx exchange-plan
pptx bench/parsers/fixtures/docs/jp_llm2.pptx jp_llm2
xlsx bench/editor/fixtures/office/large-gradebook.xlsx large-gradebook
EOF
