#!/usr/bin/env bash
# Times a single file clone's two parts (the file row with its saved edits,
# and the index copy) and the index copy's own parts against in-place
# re-tagging, on a disposable pgvector database. Needs Docker. The
# measuring code is server/internal/store/clone_cost_test.go, inside the store
# package because the clone internals are not exported.
set -euo pipefail
cd "$(dirname "$0")/../../../server"
CAPY_CLONE_BENCH=1 go run ./cmd/testdb ./internal/store -run '^TestCloneCost(Parts)?$' -v -timeout 60m 2>&1 | grep -E 'CLONECOST|CLONEPARTS|^(ok|FAIL|---)'
