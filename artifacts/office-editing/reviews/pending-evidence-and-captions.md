# Bounded independent re-verification

2026-09-06. No actionable findings remain in the reviewed scope. Both original findings and the small adjacent error-relay omission are fixed and independently verified. Review was read-only and used the frozen implementation reported in `/private/tmp/capy-pending-baseline-fixes.md`, including the first-authored-edit normalization. No repository files, live services, deployed databases or external providers were touched.

## Original findings resolved

### Ordinary source caption association after replacement

Ordinary image captioning, parsed figures and image donor lookup now opt into `require_source_job`. The worker binds ordinary payload/attempt identity, while candidate-only callers still receive only candidate context from `source_refresh_for` and `source_refresh_for_job`.

Both ordinary lookup grants and post-upload grants execute inside `_ingest_cursor`, sharing the transaction with existing `lock_pipeline_claim_boundary` and `require_current_file_source`. The bound revision/ETag, live source access, job attempt and lease are checked before insertion. Stale cancellation is committed and `SourceSupersededError` propagates, including the image donor shortcut. Model and blob operations remain outside the transaction. An upload rejected after replacement retains `artifact_cache` ownership and grants no resource association.

The adapted original delayed-upload SQL reproduction now raises before attachment. It confirms zero associations for the replacement file, one cleanup reference for the uploaded object, and no matching caption grant for another target even after the workspace is shared. Existing focused tests additionally cover the model boundary, candidate and pending paths, attempt changes, and unrelated-scope reuse.

### Captured pending edits paired with newer published content

`pending.load` now captures all scoped file IDs with revision/content alias/source epoch/indexed checkpoint in the same SQL statement as exact effects. Files without an index or pending changes remain in the private identity set. Validation uses identity-only SQL and leaves pending text unchanged. Explicit selected scopes ignore unselected additions; workspace-wide scopes detect additions and removals. Replacement, first publication, later publication and deletion invalidate the snapshot.

Authored checkpoints are deliberately excluded. The initial absent source document is normalized to the schema's epoch 1/indexed checkpoint 0, so opening/editing an existing published file for the first time does not falsely invalidate the captured answer. Existing and new ordinary edits pass the focused tests.

Chat validates before checkpoint admission, before live compaction, and after assembly immediately before model submission. Tool errors propagate as `source_changed` instead of becoming ordinary tool output. Generation validates in `produce` after gather/read. Source-image resolution validates after gateway extraction and before captioning; its separate exact-image attachment guard still protects post-response changes. Search and material tool boundaries also validate. No automatic source retry, historical retention or database transaction spanning a model request was introduced.

The adapted original SQL proof still retrieves newer C after capturing A-to-B, which is allowed internally, but final identity validation now rejects it. Actual `produce` rejects before the synthetic provider is called. The checked-in chat proof exercises the complete agent loop and proves the second model round and compaction never receive the mixed evidence.

## Go relay verified

`pipelineGenerateError` preserves `context_too_large` and `source_changed`; Huma and raw responses map them to HTTP 400 and 409 with the original codes. Both flat and nested Python error bodies are covered. Chat retains `source_changed` through `chatEventError`, avoiding the generic agent failure. The actual `huma_generate` caller invokes this mapping before `ai_unavailable` fallback. The targeted Go tests passed.

## Python ordinary-context relay also corrected and verified

The bounded relay check exposed one missing mapping: `workflows.generation_context` and its final request guard can raise `compact.ContextTooLarge`, while the Python app initially registered only `PendingSourceContextTooLarge`. The actual app returned HTTP 500 for ordinary instruction overflow, preventing the Go code from preserving a source-context error.

Root added `compact.ContextTooLarge` to the existing HTTP 400 handler in `pipeline/pipeline/retrieve/service.py:90-99`. The re-run now returns HTTP 400 with `code=context_too_large` for actual ordinary generation overflow. Pending overflow continues through the same response handler; source publication races retain the separate HTTP 409 `source_changed` handler. No retry behavior changed.

The temporary ASGI proof, `/private/tmp/test_capy_context_error_relay_rereview.py`, uses the real app middleware/exception handlers and actual `generation_context`, with real disposable SQL, a 20,000-token model and oversized instructions. Only the temporary in-process route bypasses unrelated endpoint billing/setup. No provider or blob call runs. The original assertion reproduced HTTP 500; the final assertion verifies HTTP 400 and the expected code.

## Checks run independently

- `UV_CACHE_DIR=/private/tmp/capy-uv-cache pnpm test:pipeline -- pipeline/tests/test_caption_cache.py pipeline/tests/test_pending_baseline.py pipeline/tests/test_pending_sources.py pipeline/tests/test_compact.py pipeline/tests/test_ingest_worker.py pipeline/tests/test_figures.py -q -k 'caption or pending or baseline or compact or image_donor or figure'`: **78 passed, 54 deselected**, 25.89 seconds.
- `PYTHONPATH=/private/tmp:/Users/sam/web/evo-notes/pipeline:/Users/sam/web/evo-notes/pipeline/tests UV_CACHE_DIR=/private/tmp/capy-uv-cache pnpm test:pipeline -- -c pyproject.toml /private/tmp/test_capy_pending_fixed_rereview.py -q`: **3 passed**, 5.49 seconds. These adapt the original independent SQL reproductions and assert the fixes.
- `GOCACHE=/private/tmp/capy-go-cache pnpm test:go -- ./internal/httpapi -run 'TestSourceContextErrorsRelay|TestPipelineGenerateError|TestChatEventError' -count=1`: **passed**, package 0.364 seconds, using the disposable root Go database harness.
- Temporary ordinary-context error proof after root correction: **1 passed**, 8.90 seconds, verifying HTTP 400 `context_too_large`. The preceding run reproduced the missing mapping with HTTP 500.

Only existing psycopg-pool deprecation warnings occurred. The review covers the two source consistency/privacy findings and nearby error relay. It does not retest the Office runtime, frontend recovery UX, deployed services or actual provider tokenizer limits. No additional broad scan was performed.
