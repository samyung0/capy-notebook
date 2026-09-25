# Review of C2: refresh policy, summaries and billing

Date: 2026-09-26. This is an adversarial review of the uncommitted C2 changes in the working tree. I checked them against the C2 section of `artifacts/2026-09-25-office-implementation-plan.md` and the 2026-09-25 records in `human/agentic-retrieval.md`, `human/observability-metering.md` and `human/frontend/office-files.md`. I also used `c2.md`, finding 6 of `review-c1.md` and `artifacts/2026-09-25-office-storage/summary-reuse.md` with its reference diff. C1 and its fixes are committed at `1d3f5008` and were out of scope; I read `collaboration/src/sourceHandoff.ts` only for its timing constants. I changed nothing in the repository apart from this file. Scratch scripts live in the session scratchpad, and the scratch Postgres container is gone.

`c2.md` is behind the tree. The migration is now `0029_descriptor_summaries_system_payer.sql` with `paid_by 'system'`, and its next steps (generation, tests, formatting, docs) are done.

## What was run

| Check | Result |
| --- | --- |
| Go `store`, `ops` and `agenttools` tests through the `pnpm test:go` harness, filtered to source, office, clone, checkpoint, edit-inverse, ingest, credit, privilege and share tests | All pass except the known `TestColumnLimits` failure on `pdf_annotations.text`. The new `TestOfficeAutomaticRefreshAdmission` and `TestSourceRefreshParseFeeAndSystemPayer` pass. |
| `go vet`, `gofmt -l`, `go test ./internal/agenttools` | Clean and passing. |
| `pnpm test:collaboration` | 22 files, 140 tests pass. |
| `tsc -b --noEmit`, the `pnpm typecheck` command | Passes. |
| Pipeline tests without Docker: `test_retrieval_helpers`, `test_agent`, `test_evidence`, `test_pending_sources` | 161 pass. `test_full_results_batch_as_conversation_context_on_a_small_window` fails with `RegistryError: ... no valid default thinking`. HEAD's copy of the test fails the same way, so C2 did not cause it. |
| Pipeline tests with Docker: `test_ingest_worker`, `test_registry_billing`, `test_source_refresh`, `test_store_sql`, `test_indexing`, `test_odl_local_integration` | 169 pass, 1 skipped. On Windows they need a scratch `fcntl` stub on `PYTHONPATH` because `ingest/capacity.py` imports it. Without the stub, 8 `test_store_sql` cases fail at import. |
| `ruff format --check`, `ruff check`, `biome format` on the C2 files | Clean. |
| `gen:openapi` into a scratch folder | Byte-identical to the tree's `openapi.yaml`, `agent_tools.json`, `slot.py`, `limits.py` and `limits.generated.ts`. |
| The scheduler SQL in a scratch Postgres with every migration applied, 0029 included | Parameters resolve to `bigint, interval, interval`. `rag_content_summaries` has `change_share` and no `summary`. `provider_sessions_paid_by_check` allows `system`. |

Scratch experiments, all read-only against the repository:

- `gate_equiv.py` compares the shipped `text_change_tokens` with the reference `text_changes` in `probes/delta/delta.py` on 3,000 random chunk lists. The lists include overlap blocks, retained headings, spacing-only edits, ligatures and CJK.
- `gate_perf.py` and `gate_csv.py` time `text_change_tokens` on prose, on pipe-separated tables in the chunker's `flatten_table` form, and on a CSV through the real `tabular_text` and `chunk_markdown`.
- `gate_capped.py` runs the same inputs through a bounded variant, see finding 1.
- `moves.mts` counts pending effects and trimmed tokens for one inserted paragraph. It uses the pinned engine's `officeBaseline` entries for `rich-content/exchange-plan.docx`, its `compareBaselines`, and C2's own `trimEffect` and `effectTokens`.
- `sched.sql` and `stale.sql` run the C2 scheduler query against seeded rows, see finding 3.

## Findings, ranked

### 1. High: the summary gate's text diff can hold an ingest worker for minutes or hours

`pipeline/pipeline/retrieval/indexing.py:328`, where `_descriptor` calls `text_change_tokens`, and `:363-405`.

**Defect.** The ported diff runs `difflib.SequenceMatcher(autojunk=False)` over the changed line ranges and then over the words in each range. Both passes go quadratic or worse on repetitive sequences, and tables repeat a lot: `|`, `Row`, `Passed=Yes`, `0`. When one edit touches every line, the whole document becomes a single word-level range. The call is synchronous and runs inside the ingest job's event loop, after the embeddings. The reference script has the same cost. The storage report measured it on prose only, 0.4 s on the book.

**Evidence.** The reference `text_changes` took the same time on every input within noise, and it matched the shipped function exactly in all 3,000 random trials.

| Input | Change | Time |
| --- | --- | ---: |
| Prose, 180k words | one word | 0.21 s |
| Prose, 180k words | contiguous 10% rewrite | 13.2 s |
| Table, 1,000 rows by 8 columns | one cell | 0.02 s |
| Table, 1,000 by 8 | column appended | 41 s |
| Table, 2,000 by 8 | column appended | 167 s |
| Table, 3,000 by 8, and 10,000 by 10 | column appended | over 150 s, killed |
| Table, 2,000 and 3,000 by 8 | rows sorted | 65 s and 127 s |
| CSV through `tabular_text`, 500 rows | one row inserted at the top | 174 s |
| CSV through `tabular_text`, 1,000 rows | one row inserted at the top | over 400 s, killed |

**Failure scenario.** A user opens a 2,000-row CSV in the text editor and inserts a row near the top. `_TABULAR_MAX_CELLS` allows 20,000 rows of five columns. `tabular_text` starts every line with `Row N:`, so every line changes. The 15-second text refresh runs `index_file`, and the gate starts a word diff over the whole file. `asyncio.timeout` with `CAPY_INGEST_TIMEOUT=1200` cannot interrupt synchronous code. It fires only when the diff returns, then the worker restarts with `os._exit(1)` and the retry runs the same diff. Each ingest replica runs one job at a time, and the Netcup host serves production, UAT and local development. A few such files stall ingest for everyone. XLSX and DOCX tables reach the same code through the parser, where a column insertion or a sort rewrites every row line.

**Lazy fix.** When both sides of a changed line range exceed about 2,000 words, count the whole range as changed and skip the word diff. That count is an upper bound, so the gate can only regenerate earlier, never reuse longer. I measured the prototype in `gate_capped.py`. 500, 1,000 and 5,000-row CSVs finished in 0.09, 0.15 and 0.62 s. A column appended to 2,000 by 8 and 10,000 by 10 tables took 0.89 and 2.1 s. Sorting 3,000 by 8 and 10,000 by 10 tables took 4.1 and 1.6 s. Every measured case regenerates under both versions, with shares between 32% and 200%, so no decision changed. Add one test with a renumbered 1,000-row CSV that must finish fast. The line-level pass can still be slow on a document made of many identical lines. An early exit once the running total passes the 2% budget, or a size cap on the line diff, would cover that.

### 2. High: paragraph moves carry 40 unchanged characters each, so one inserted paragraph can trip the 3,000-token trigger

`collaboration/src/sourceDocuments.ts:186-211`, `trimEffect`, together with `vendor/betteroffice/shared/office-checkpoint.ts:279` and `:1062-1079`.

**Defect.** A DOCX paragraph's position is its index in the story, and PPTX works the same way per text story. Inserting or deleting one paragraph therefore gives every later paragraph a `move` effect whose `before` and `after` are equal. `trimEffect` finds no changed span and keeps the last 40 characters on both sides, which `c2.md` left as an open question. So each move costs about 21 tokens of English, or up to about 80 in CJK. The record calibrates 3,000 trimmed tokens as about 60-70 edited paragraphs. The measurement behind that number, `probes/cross-shrink/dump_values.mjs`, used in-place `replace_text` edits only and never produced a move.

**Evidence** from `moves.mts`:

| Document | Edit | Effects | Trimmed tokens, from moves | Untrimmed |
| --- | --- | ---: | ---: | ---: |
| `rich-content/exchange-plan.docx`, 116 body paragraphs | one paragraph inserted after the first | 116, 115 of them moves | 3,055, of which 3,047 | 10,001 |
| 300 English paragraphs | one paragraph inserted at 5 | 296, 295 moves | 6,203, of which 6,195 | 55,716 |
| 300 English paragraphs | one paragraph inserted at 150 | 151, 150 moves | 3,158, of which 3,150 | 28,334 |
| 300 English paragraphs | one word replaced | 1 | 42 | 189 |

**Failure scenario.** Take any document with more than about 140 paragraphs after the edit point, or about 40 in Japanese. The user presses Enter, types a sentence and pauses for a minute. The file is now due, and the automatic refresh runs. The owner pays embeddings for the chunks the insertion re-packed, which is cheap. The costly part is the publication itself. Each open editor of the file goes read-only under the reload banner, per records 19 and 20. Every chat request meanwhile carries hundreds of moves whose text did not change. This is not a regression. Before C2 a move carried the whole paragraph twice, and one insertion crossed the old 5,000 threshold too. But the trimmed trigger does not do what the record describes.

**Lazy fix.** Drop `before` and `after` from text `move` effects and keep the id and label. A move has no changed span, which fits the record's wording, and the chat evidence loses nothing because the text did not change. Weight them at 0 tokens, or at 1 like visual placeholders. If they weigh 0, apply the `net_tokens > 0` part of finding 3 as well, or a change list made only of moves gets selected and refused forever. This needs a yes from the developer. The calibration also assumed English. A one-character edit in a CJK paragraph costs about 80 tokens, so CJK files reach 3,000 after roughly 37 edited paragraphs.

### 3. Medium: rows the scheduler refuses but never parks can starve every other file

`collaboration/src/sourceDocuments.ts:896-935` and `server/internal/store/source_documents.go:441`.

**Defect.** Every 5 s the scheduler takes `ORDER BY d.last_edited_at LIMIT 8`. As the record asks, a 429 now `continue`s and writes nothing, so the same rows come back first on the next run. Nothing moves them behind other files.

**Failure scenario.** Owner A starts a bulk upload that holds all 20 ingest leases for half an hour. A also has eight or more eligible Office or text files, edited before anyone else's. Each run selects A's eight files, collects eight 429s and never reaches another owner's due file until A's leases drain. Each attempt also takes the file's advisory lock and A's account and credit row locks.

The new 7-day branch adds a rarer second trigger. The scheduler requires `jsonb_array_length(pending_effects) > 0`, while Go answers `NetTokens == 0` with 409. Before C2, the 5,000-token floor kept zero-token Office rows out of the automatic branch, but the stale branch has no floor. In the scratch Postgres, `stale.sql` seeded eight PPTX rows whose only effect was an empty-text move, last edited 8 days ago, and two rows at 3,000 tokens. The query returned only the eight stale rows. Go refuses each with 409 and the scheduler skips 409 without parking, so the two due rows never get picked. Finding 2's fix makes move-only lists more likely.

**Lazy fix.** Add `d.net_tokens > 0` to the scheduler's WHERE so it matches Go. For 429 there are two options. The query can skip owners already at the cap, using the same count as `beginIngestSpendTx` against `ConcurrentIngestLeases`, which adds one more constant shared with Go. Or the scheduler can set `last_refresh_requested_at` on a 429 and order the Office branch by the later of the two timestamps, so refused rows rotate to the back.

### 4. Low: the risky paths lack tests

- No test checks that a `paidBy: "system"` payload skips the claim-time credit check while other payloads keep it. The check is at `pipeline/pipeline/ingest/worker.py:792`. `test_registry_billing.py:176-190` covers only the ordinary cases.
- `trimEffect` has no case for a `move`, for a surrogate pair at the end cut, or for the trimming in `rebasePublication` at `sourceDocuments.ts:546-555`.
- Nothing asserts that donor copy, `store.py:722-739`, or workspace clone, `share.go:1230-1236`, carries `change_share`. `test_donor_copy_reuses_chunks_across_workspaces` stores 0.0 and never reads it back.
- No test runs the scheduler SQL against a database. The Go admission test covers the constants on the Go side only.
- No test bounds the gate diff's running time, see finding 1.

### 5. Low: leftover references and commit hygiene

- `bench/rag/scripts/workspace_opening_agentic.py:396` still offers `describe_documents`. The playground drops unknown tool names silently at `lab/playground/scripts/playground.py:1357`, so a replay runs a different tool set from the recorded one. `bench/rag/scripts/workspace_agentic_retrieval.py:388` and `capture_visual_probe.py:121` have the same leftover. The script's other edit, dropping the `summary` column from the snapshot check, is right. `knowledge-base-plan.md` is right as edited.
- C2's lab edits are in `lab/playground/scripts/playground.py`, `configs/chat.json`, `README.md` and `scripts/ui.html`, inside the `lab/*` tree that the progress README keeps out of commits. `configs/curate.json` holds only the developer's diagram-description line. The C2 commit needs the four C2 files and not `curate.json`.

### 6. Low: deploy order

- `_parse_fee` reads `payload["parseFee"]` at `worker.py:1134`. A source-refresh job queued by the old gateway raises `KeyError` in `_settle_published_source_refresh`, after its publication has landed. The plan wants no shim, so drain `source_refresh` jobs before deploying C2.
- Migration 0029 drops `summary` and adds `change_share`. The old pipeline writes `summary` and the new one writes `change_share`, so the gateway's migration and the ingest host's image must change together. One nonprod ingest image serves both local development and UAT, `deploy/docker-compose.ingest-host.nonprod.yml:62`, so a developer's local database has to migrate when UAT does.

## For C4, not C2 defects

C2's system payer covers what C2.5 asks for: no credit check or reservation, usage at zero credits, no ingest lease. Record 23 asks more of the maintenance path, and several older checks still apply to a `system` refresh:

- `requestSourceRefresh` still calls `sourceLockTx` with `edit=true`, which refuses owners whose account state blocks editing, `source_documents.go:415`. It still runs `gateStorageTx` at `:481`.
- The worker's first claim still runs `ingest_accounts_active` and `account_allows_ingest(owner)`, which includes storage, at `worker.py:786-789`. `PublishSourceRefresh` still calls `sourceLockTx` with `edit=true` and gates storage growth, `source_refresh.go:242` and `:293`.
- When a job is already running, a `system` request only records `desired_checkpoint`, `source_documents.go:452-458`. The follow-up refresh is then an ordinary owner-paid request. A credit-blocked owner's file never publishes, and the readiness check never reaches zero.
- A `system` refresh of a never-parsed file parses it free, because `parseFee` is false for `system` and `mode == "none"` becomes `fast`. The maintenance command must send store-only files to export-only, as the record says, and never through `requestSourceRefresh`.
- `beginSystemIngestSessionTx` relies on its caller already holding the account-session lock that `sourceLockTx` takes.
- Record 22's store-only auto publish needs its own branch in the same scheduler query.

## Checked, nothing wrong found

- **Who can pay `system`.** Only the unexported `requestSourceRefresh` sets it, and today only tests call it. `BeginProviderSession` rejects anything but `platform` and `user` at `credits.go:380`. The HTTP refresh routes call `RequestSourceRefresh`, which passes `platform`. Go builds job payloads from fixed maps in `jobs.go:181-207`, and the pipeline copies them unchanged at `worker.py:1276`. No user input reaches `paidBy`.
- **Claim time and settlement.** The claim-time skip trusts the payload. Settlement trusts the session row, `db.py:2083-2100`, and Go writes both from one variable in `source_documents.go:465-488`. Every ingest provider call, audio included, settles through `settle_ingest_provider_call`. It zeroes credits for `system` before the duplicate comparison, so a replay stays an exact duplicate, which `test_store_sql.py` covers. Reservations hold 0 and settle 0.
- **Parse fee.** Go computes `parseFee = !ever && paidBy != system` at admission, under `FOR UPDATE`, and the parse and ingest jobs carry it. Every parse-usage writer passes `_parse_fee(payload)`: the handoff, failed attempts and the published settle. `_finish_ok` charges with `charged=True` only for jobs that are not refreshes, since `process_ingest_job` binds the refresh context for every job. Text refreshes carry `parseFee: true` because text files never set `ever`, but they record no pages. A refresh without the fee records its pages at 0 credits with `metadata.parseFee=false`.
- **Lease counts.** Both counts exclude `system`, `credits.go:809` and `:864`. Go's settlement and exhaustion flag charge only `platform`, the ops listing only displays the value, and no Go path settles an ingest session.
- **Migration 0029.** Every reader of `summary` was updated: the Go clone in `share.go`, the pipeline's donor copy and `workspace_outline`, the removed `file_summaries`, and the ops forbidden-column list in `privileges.go`. `deploy/ops-roles.sql` never names the column. Only the Go session openers write `paid_by`. `e2e/uat/journeys/files.ts:282` counts rows and still works.
- **Gate logic.** Apart from the running time in finding 1, the gate behaves as specified. `text_change_tokens` matches the reference exactly. The share resets to 0 on regeneration. A stale `summary_version`, a missing published row and an empty previous content all regenerate. Reuse makes no provider call, and regeneration raises `RetryableError` as before. `published_summary` reads before any write and follows `rag_file_contents`, which still points at the published content during a refresh, `store.py:386-407`.
- **Share semantics.** The stored share sums per-refresh shares instead of measuring net change since the last regeneration. A revert therefore counts twice, which only regenerates earlier. The storage report's policy replay did the same.
- **Trimmed effects.** The span is right, and neither cut splits a surrogate pair. `add` and `remove` effects stay whole, as do non-text effects and every text-format effect. `effectTokens` and Go's `sourceEffectTokens` count the stored strings with the same formula, `…` included. `rebasePublication` takes `netTokens` from the trimmed list. Chat evidence still works. Nothing applies `before` and `after` mechanically, `pending.py` hands the JSON to the model with the new excerpt instruction, and captions key on `id` and `imageSHA256`.
- **Trigger.** The scheduler, `sourceDocuments.ts:896-911`, and Go admission, `source_documents.go:441-450`, encode the same rule. The scheduler's strict `<` against Go's `>=` makes it a little stricter, never looser. A 429 writes no `refresh_error`, and 409 and every other status behave as before. The new vitest covers this.
- **Timeouts.** The room lock is 180 s, the 60 s acknowledgement wait plus the 120 s engine timeout, and the watchdog is 185 s. The gateway waits 200 s on the publish operation only, `source_proxy.go:19` and `:38`. The pipeline waits 210 s on publish only, `worker.py:83` and `:400`. The job-lease heartbeat runs in its own thread during the wait, and the gateway sets no write or router timeout. One narrow gap remains. The coordinator can pass its last lease check just before 180 s and then spend up to 60 s in the Go publish call. If the gateway gives up first, the worker retries and finds the publication through `_source_refresh_published`.
- **Finding 6.** `SaveSourceCheckpoint` reads sizes with `octet_length` under the file's advisory lock, which publication also takes, `source_refresh.go:219`. The growth arithmetic gives the same numbers as the old byte lengths, jsonb text for effects and bytea length for state and baseline. `RETURNING checkpoint` returns the new value. A replayed operation returns the current checkpoint and its stored receipt.
- **Contract.** `SourceSession.Operation` is gone. `state` and `indexedBaseline` are nullable in the Go tags, `openapi.yaml` and the generated client, and the frontend already guards `state` at `useSourceSession.ts:204` and `useOfficeRuntime.ts:203`. Collaboration's own `SourceSession` type keeps both as non-null strings. That holds while both columns are `NOT NULL`, but C5's NULL state will need `COALESCE(octet_length(state),0)` at `source_documents.go:272` and a nullable field there.
- **Dead code and docs.** `describe_documents`, `_describe_note`, `_get_json`, `required_file_ids`, `file_summaries`, `_summary_word_target` and `_parse_summary_payload` are gone, along with their tests. The two history records in `human/agentic-retrieval.md` are rewritten. The openwiki pages and the test catalog describe the new behaviour.

## Open questions for the developer

1. Should a text `move` carry no text, per finding 2? If so, should it weigh 0 tokens or 1?
2. Should the 3,000-token trigger be retested on CJK documents? There, 40 characters of context cost about four times as many tokens.
3. Is an upper-bound count for oversized ranges acceptable in the gate, per finding 1? It can only regenerate earlier.
4. For 429 rows, per finding 3: skip capped owners in SQL, which adds a constant shared with Go, or rotate refused rows by `last_refresh_requested_at`?

## Summary

C2 implements all five plan items, and the billing is sound. Only the unexported maintenance entry can open a `system` session. Settlement zeroes credits from the session row. The page fee lands exactly on a file's first parse, and both lease counts ignore `system` sessions. The migration's readers and writers all line up. Trimming, the trigger constants, the timeouts and the finding 6 checkpoint rewrite are correct.

Two problems need work before C2 ships. The reference diff behind the 2% gate goes quadratic on tables. One inserted CSV row or one sorted sheet holds an ingest worker for minutes, and a large enough file holds it for hours, on the host every environment shares. A cap on the word diff fixes it without changing any measured decision. Moves still carry 40 unchanged characters each, so one inserted paragraph in a long document crosses the 3,000-token trigger meant for 60-70 edited paragraphs. That fix needs a quick developer decision. The scheduler should also stop letting refused rows sit at the head of its batch. The rest is tests, leftovers and deploy order.
