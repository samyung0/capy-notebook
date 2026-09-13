# Fix round 1

Source: `review-1.md`. Every item below is decided by the developer on
2026-09-12 and recorded in `human/`; apply exactly, no re-litigating. Finding
numbers refer to `review-1.md`.

## Majors

- **F1 Fold the lab packer into production chunking.** In the ingest worker's
  chunk stage, reproduce `bench/rag/scripts/odl_agentic_prepare.py::pack_odl`
  = `experiment_odl_table_integration.stable_chunks` (furniture computed on the
  pre-table-replacement block view and frozen; native tables carrying
  `_native_table_supported` emitted through the structured table chunker as
  their own chunk(s) with header repetition, `_table_spans` merged-cell notes
  and `_native_table_title` as `section_path`) followed by `retain_headings`.
  The parser may carry the frozen furniture texts in the bundle (it knows the
  dropped blocks in `recover_tables`), and the `Table`/`checked_spans` code in
  `parser/odl/table_html.py` moves or is shared into `pipeline/retrieval`. Bump
  `CHUNKER_VERSION`. Prove it with a test that feeds a saved refined bundle
  (one lab source with a recovered table and a running header inside a
  replaced region) and asserts the chunk sequence equals the lab
  `chunks.json` for that source (the VM has them under
  `/opt/capy-odl-third-pass-20260909/refined-final-r1/<source>/chunks.json`;
  copy one small source's `content_list.json` + `chunks.json` into
  `pipeline/tests/fixtures/`).
- **F2 Wrong-shape JSON answers go to the repair call.** Take the streamed
  path only when the renderer produced text; a complete render with empty
  text routes to `_repair_answer`. Add `{"answer": "string"}`,
  `{"answer": {...}}`, `{"answer": []}` cases to the tests.
- **F3 Migration 0008 idempotent.** Deactivate only `version = 1` (or use
  `ON CONFLICT ... DO UPDATE SET active = true`); re-running the file must
  leave exactly one active row per key.
- **F4 Test path.** `pipeline/tests/test_capture.py:223` resolves the contract
  relative to the test file (or via `pipeline.retrieval.contract`).

## Minors

- **F5 PARSER_TIMEOUT covers the queue.** Set `PARSER_TIMEOUT` to queue depth
  × 600 s plus margin (2400 s + margin) and raise `CAPY_PARSE_JOB_TIMEOUT` and
  the lease/validator ladder with it (`config.py`, `jobs.py`, both ingest-host
  composes, `docker-compose.yml`, env examples, `env-manifest.json`,
  runbook); `pnpm test:deployment` must pass.
- **F6 Font-repaired PDF for the post-passes.** When `repaired_fonts > 0` the
  parser ships the repaired PDF (or the worker applies `fonts.repair_fonts`
  before heading retention and confidence). Test: a source that trips the
  Type1/ToUnicode gate scores like the lab.
- **F7 No interim citations events.** `_run_tools` stops emitting the
  all-passages list; only the final renumbered list is sent. Adjust
  `useChatStream` tests if they assert interim lists.
- **F8 Context telemetry excludes base64 images.** Measure `provider_messages`
  with image parts removed and add the per-image patch estimate.
- **F9 Image tokens in the compaction budget.** Pass the sum of attached
  images' estimated tokens as `extra` to `compact_messages` / `pending.reserve`.
- **F10 Capture cache key includes the blob path** (`sha256(preview_blob_path
  or blob_path)` or the basename in the file name).
- **F11 Billing keeps the `caption` label** for historical usage rows
  (`src/routes/Billing.tsx`, keep `billing_kind_caption` in en/zh).
- **F12 Docs.** Deadline starts when the document leaves the queue (before
  LibreOffice); queue depth wording "one executing, three waiting"; annotate
  `.todo:21` and `important-artifacts/office-editing/plan.md:143` as
  historical.
- **Slot default.** Migration `0009` also moves the catalog chat slot default
  to `zai/glm-5.3-flash`: clear `chat` from DeepSeek Flash's `is_default_for`,
  add it to GLM's, bump `model_registry_state.version`, in one transaction
  (the trigger requires the clear first). Update the Go tests that pin DeepSeek
  Flash as the slot default (`server/internal/store/chat_pin_test.go` and any
  registry test). Decision: `human/agentic-retrieval.md` (GLM is "the
  catalog's chat slot default").
- **Stale decision wording** the reviewer listed (DeepInfra GLM route,
  captioning slot wording, MinerU crops, `figures.py` references in older
  `human/` lines) is the orchestrator's to handle; do not edit `human/`.

After the fixes: run `pnpm run fmt`, `pnpm run fix`, `pnpm run fmt:go`,
`pnpm run fmt:py`, `pnpm test:pipeline:offline`, `pnpm test:pipeline:replay`,
`pnpm test:go`, `pnpm test`, `pnpm test:deployment`, the type checks, and
`go vet ./...`. Update `openwiki/test-catalog.md` for any test added. Report
per finding what changed (file:line) and the test that proves it.
