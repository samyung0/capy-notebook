# Recheck of the C2 fixes

Date: 2026-09-26. This rechecks findings 1, 3, 4 and 5 of `review-c2.md` against the working tree, plus any regression the fixes introduced. Findings 2 and 6 were skipped as instructed. I changed nothing in the repository apart from this file, and no scratch or test containers remain.

| Finding | Verdict |
| --- | --- |
| 1. Gate diff can hold an ingest worker | Partly fixed. Symmetric ranges are bounded; a range with one small side still runs the full word diff. |
| 3. Scheduler starvation | Fixed. |
| 4. Tests on risky paths | Mostly fixed. Two `trimEffect` cases are still missing; the move case waits on finding 2. |
| 5. Leftover references | Fixed in code. The lab split is a commit-time item. |
| Regressions | None found. |

## Finding 1: partly fixed

`pipeline/pipeline/retrieval/indexing.py:382` adds `_WORD_DIFF_CAP = 2000`. At `:407`, a changed range counts whole when `min(len(aw), len(bw)) > _WORD_DIFF_CAP`, so both sides must exceed the cap before the word diff is skipped.

**Fixed cases.** I re-ran the review's inputs against the working tree with `gate_recheck.py`:

| Input | Before | Now |
| --- | ---: | ---: |
| CSV, 500 rows, one row inserted at the top | 174 s | 0.07 s |
| Table, 2,000 by 8, a column appended | 167 s | 0.25 s |
| CSV, 180 rows, one row inserted at the top: 1,990 and 2,001 words, just under the cap | | 8.0 s |
| CSV, 90 rows, one row inserted at the top: 1,000 and 1,011 words | | 1.1 s |

The new test `test_text_change_counts_a_renumbered_csv_whole_and_fast` at `pipeline/tests/test_retrieval_helpers.py:1388` pins the symmetric case at under 5 s, line 1419. It passes on Windows without the `fcntl` stub.

**Still open.** The `min` rule lets a range through when one side stays under 2,000 words, whatever the size of the other side:

| Input | Words, old and new | Time |
| --- | --- | ---: |
| CSV, 180 rows, 5,000 rows pasted at the top | 1,990 and 56,990 | 61 s |
| CSV, 180 rows, 10,000 rows pasted at the top | 1,990 and about 110,000 | 111 s |
| CSV, 5,180 rows, the top 5,000 deleted | 56,990 and 1,990 | 8.7 s |

The cost grows roughly linearly with the large side. At the 100,000-cell CSV limit, about 20,000 rows, it would be about 4 minutes of blocked event loop per refresh. That is no longer the hours-long blow-up, but it is still minutes. For scale, chunking the 10,000-row CSV took 285 s by itself. That cost predates C2, so large CSV refreshes are slow regardless of the gate.

**Lazy fix.** Count the range whole when either side exceeds the cap: `max(len(aw), len(bw)) > _WORD_DIFF_CAP`. With `max`, the 5,000-row paste took 0.45 s (`gate_recheck3.py`). The rule is still an upper bound, so the gate can only regenerate earlier. A cap of 1,000 words would also bring the symmetric worst case from 8 s to about 1 s. Extend the new test with one pasted-block case.

## Finding 3: fixed

- `collaboration/src/sourceDocuments.ts:51-59` adds `d.net_tokens>0` to the candidate query, line 55. This matches Go's `NetTokens == 0` refusal at `server/internal/store/source_documents.go:441`. The query now orders by `GREATEST(d.last_edited_at,d.last_refresh_requested_at)`, line 59.
- On a 429, `sourceDocuments.ts:933-934` runs `REFRESH_DEFER_SQL`, which stamps `last_refresh_requested_at=now()`, and moves on. The refused file then sorts behind the other due files instead of heading every batch.
- The vitest at `collaboration/src/sourceDocuments.test.ts:99` checks that the 429 file is stamped and the 402 file is parked.
- The Go test `TestRefreshSchedulerQuery` at `server/internal/store/source_documents_test.go:164` reads both statements and the constants from the TS file and runs them against Postgres. It checks that:
  - the constants equal Go admission's;
  - the zero-token row is excluded (line 204);
  - the stale file comes before the due file;
  - after the defer statement, the refused file comes last (line 244).
- Regression check. Only the scheduler's 15-second text gate and its ordering read `last_refresh_requested_at`, plus Go's text admission at `source_documents.go:427` and `:446`. The stamp's one side effect is that a deferred text file waits at least 15 s before its next try, which is fine.
- Ordering by an expression cannot use `source_documents_pending_idx` for the sort. It is a top-8 sort over the pending rows every 5 s, which is negligible at current sizes.

## Finding 4: mostly fixed

| Gap | Status | Evidence |
| --- | --- | --- |
| The claim-time credit skip for `paidBy: "system"` | Fixed | `pipeline/tests/test_registry_billing.py:189` onward. A system payload is admitted without credits, a platform payload is refused, and the owner check still applies. |
| Donor copy keeps `change_share` | Fixed | `pipeline/tests/test_store_sql.py:2065` asserts 0.0125 on the copy |
| Workspace clone keeps `change_share` | Fixed | `server/internal/store/source_documents_test.go:544` asserts 0.0125 on the cloned file's descriptor |
| Scheduler SQL against a database | Fixed | `TestRefreshSchedulerQuery`, above |
| A bound on the gate's running time | Fixed for the symmetric case only | `test_retrieval_helpers.py:1388`; the pasted-block case from finding 1 is untested |
| `trimEffect` with a surrogate pair at the end cut | Not fixed | `collaboration/src/sourceDocuments.test.ts:76-97` is unchanged and tests only the start cut |
| Trimming in `rebasePublication` | Not fixed | The rebase test around `sourceDocuments.test.ts:454` uses only an image effect, so nothing checks that rebased text effects are trimmed or that `netTokens` counts the trimmed text |
| A `move` effect | Deferred | Waits on the finding 2 decision |

## Finding 5: fixed in code

- `bench/rag/scripts/workspace_opening_agentic.py:393-399` no longer offers `describe_documents`. The same fix landed in `workspace_agentic_retrieval.py` and `capture_visual_probe.py`.
- No code reference to the tool remains. The remaining mentions are history in `human/`, `openwiki/`, `knowledge-base-plan.md`, dated reports and artifacts.
- The lab split is unchanged and belongs to commit time. The four C2 lab files still carry C2's hunks, and `lab/playground/configs/curate.json` still carries only the developer's diagram-description line.

## Regressions

None found.

- The Go `store` tests pass through the `pnpm test:go` harness, filtered to source, office, clone and ingest tests. That run includes `TestRefreshSchedulerQuery`, `TestOfficeAutomaticRefreshAdmission`, `TestSourceRefreshParseFeeAndSystemPayer` and `TestSourceCloneCopiesPublishedSnapshotAndCaptionReferences`.
- `pnpm test:collaboration` passes: 22 files, 140 tests.
- `tsc -b --noEmit` passes.
- The pipeline tests for the fixes pass: the gate, the claim skip, the donor copy and the indexing tests.
- `biome format`, `ruff format --check`, `ruff check`, `gofmt -l` and `go vet ./internal/store` are clean.

One behaviour change comes with the cap and is intended rather than a regression. If every line in a long stretch is re-split without any word changing, for example by a parser change, the range now counts whole and the descriptor regenerates. The uncapped diff would have found no change, but on a range that large it could not finish in reasonable time anyway.

Scratch scripts are in the session scratchpad: `gate_recheck.py`, `gate_recheck2.py`, `gate_recheck3.py` and `gate_recheck4.py`.
