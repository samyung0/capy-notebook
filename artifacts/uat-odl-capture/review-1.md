# Review 1: refined ODL parser, capture_page, structured citations

Reviewed the whole uncommitted diff on `main` (123 modified, 7 deleted, ~25 new
files outside `bench/`) against `artifacts/uat-odl-capture/plan.md`, the four
`human/` decision files and the four open questions in `decisions-needed.md`.
Read-only pass; nothing was changed.

## Summary

| Severity | Count |
| --- | ---: |
| blocker | 0 |
| major | 4 |
| minor | 9 |

The parser port (`parser/odl/*`) is function-for-function faithful to the lab
scripts; the six A3 contracts hold; the migrations, route switch, limits,
prompt and removal are complete. The four majors are: the chunk stage does not
reproduce the lab's packer (so the UAT index will not match the lab index the
twelve-question acceptance was measured on), a complete-but-wrong-shape JSON
answer becomes an empty persisted answer with no repair call, migration `0008`
is not idempotent and would deactivate every parse rate if version-2 rows
already exist, and one new test fails in `pnpm test:pipeline:offline` because
of a cwd-relative path.

## Findings

### F1 (major) Chunk stage differs from the lab packer the acceptance numbers were measured on

`pipeline/pipeline/ingest/worker.py:1727-1740` (`_page_chunks`) runs
`chunk_content_list` → `retain_headings` → `score_chunks`. The lab index that
the twelve-question playground batch and the NIST "Table 2" confidence check
were run against was built by `bench/rag/scripts/odl_agentic_prepare.py:47-54`
(`pack_odl`): `experiment_odl_table_integration.stable_chunks` (frozen furniture
plus `chunk_native_bounded`) and then `retain_headings`. Two behaviours of that
packer are not in production:

1. Frozen furniture. `stable_chunks` (`experiment_odl_table_integration.py:207-230`)
   computes `_repeated_across_pages` on the blocks *before* source-geometry
   table replacement and then patches the chunkers so no new recurrence is
   inferred afterwards. Production `chunking.py:507` recomputes furniture on
   the post-replacement list. Scenario: a running header appears on pages
   3, 4, 5; on page 4 it sits inside a ruled region that `recover_tables`
   replaces, so the header block is dropped there; the text now recurs on 2
   pages, below `_REPEATED_ON_PAGES = 3`, and is indexed as body text on pages
   3 and 5 (and vice versa for text the replacement makes newly repeated).
2. Native-table isolation. `chunk_native_bounded`
   (`experiment_odl_native_tables.py:170-206`) emits every block carrying
   `_native_table_supported` through `chunk_structured([block])` as its own
   chunk(s) with header repetition, `_table_spans` annotations
   ("[one merged source cell, rows …; columns …]") and
   `section_path = _native_table_title`. Production `chunking.py:547-553`
   flattens `table_body` and packs the table with its neighbours; the parser
   still writes `_native_table_supported`, `_table_rows`, `_table_spans` and
   `_native_table_title` into the bundle but nothing reads them. Scenario: the
   NIST Table 2 block is one chunk with the title as section path in the lab;
   on UAT it is part of a token-bounded prose chunk, so "the Table 2 chunk
   carries a note below 0.9" (plan, Verification 2) and the "same eleven of
   twelve" expectation (Verification 3) are measured on a different index.

Plan §1 step 6 says "Chunking unchanged, with the ODL packer's furniture and
heading retention folded in"; only heading retention was folded in. Smallest
fix: in `_page_chunks`, compute the furniture set once from the bundle's
pre-replacement view (the parser can carry it: `recover_tables` knows the
dropped blocks, or the parser writes `_furniture` texts into the bundle), pass
it into `chunk_content_list` instead of recomputing, and give
`chunk_content_list` the `chunk_native_bounded` branch for
`_native_table_supported` blocks (the `Table`/`checked_spans` code already
exists in `parser/odl/table_html.py` and can move to `retrieval`). Bump
`CHUNKER_VERSION` again. If the developer prefers production packing, record it
as a decision and re-run the twelve questions against a production-chunked
index before UAT sign-off.

### F2 (major) A complete JSON answer of the wrong shape is persisted as an empty answer, without the repair call

`pipeline/pipeline/retrieval/agent.py:534` takes the streamed path when
`renderer.json_shaped and (renderer.complete or renderer.text)`. `complete` is
true for any closed top-level object, including shapes `parse_structured`
(`structured.py:79-95`) rejects. Verified with the module:
`{"answer": "just a string"}`, `{"answer": {"text": "...", "passages": [1]}}`
and `{"answer": []}` all give `json_shaped=True, complete=True, text=""`, so the
agent emits `block_start`, `block_delta("")`, `block_end("answer")`, an empty
`citations` event and `done`; Go persists an empty assistant message. The
decision (`human/agentic-retrieval.md`, 2026-09-12) requires one repair call
when the answer does not parse; the non-streaming fallback
(`parse_structured` → `_repair_answer`) would have repaired exactly these.
Scenario: GLM, tools-off final call, `json_object` on, model returns
`{"answer": "The table shows …"}` → user sees an empty reply and no citations.
Fix: take the streamed path only when `renderer.text` is non-empty
(`renderer.json_shaped and renderer.text`), and route a complete-but-empty
render to `_repair_answer`; add the three shapes above to
`test_structured.py`/`test_agent.py`.

### F3 (major) Migration `0008_parse_page_rates.sql` is not idempotent and deactivates version 2 if it already exists

`server/migrations/0008_parse_page_rates.sql:6-13` runs
`UPDATE … SET active=false WHERE resource_key IN (…) AND active` then
`INSERT … ON CONFLICT (resource_key, version) DO NOTHING`. Any state in which a
`version = 2` row is already active (the plan §7 explicitly proposed an Ops
"new active version" action on UAT for the live rows; or a manual re-apply of
the file) ends with no active `digital_parse_page` / `ocr_parse_page` row:
`server/internal/store/pricing.go:72` then fails every upload with
"active resource rate … is missing", and `worker.py:_REQUIRED_RESOURCE_RATES`
refuses parse jobs. The migrator applies each file once by checksum
(`store/migrate.go:136-159`), so the normal 0005→0009 path is safe, but the
file is the only one of the four new ones that is not re-runnable
(`0006`/`0007` use `IF [NOT] EXISTS`, `0009` is a plain default). Fix: restrict
the deactivation to `version = 1` (or `version < 2`), or use
`ON CONFLICT (resource_key, version) DO UPDATE SET active = true` after the
deactivation. The unique partial index `resource_credit_rates_active_idx` is
satisfied inside the transaction in both orders.

### F4 (major) `pnpm test:pipeline:offline` is red: `test_capture.py` reads a cwd-relative path

`pipeline/tests/test_capture.py:223`:
`Path("pipeline/generated/agent_tools.json")`. From the repository root (how
`pnpm test:pipeline:offline` and CI `uv run --extra test pytest` run) the file
is `pipeline/pipeline/generated/agent_tools.json`, so the test raises
`FileNotFoundError` in every environment:

```
FAILED pipeline/tests/test_capture.py::test_capture_page_is_offered_with_the_read_operation
1 failed, 589 passed, 120 deselected, 5 warnings in 6.27s
```

Fix: `Path(__file__).resolve().parents[1] / "pipeline" / "generated" / "agent_tools.json"`,
or read the contract through `pipeline.retrieval.contract` (which already
loads the embedded file).

### F5 (minor) Client timeout does not cover a full parser queue

`pipeline/pipeline/config.py:117-128`: `PARSER_TIMEOUT` 840 s, job 900 s; the
parser admits `CAPY_PARSE_QUEUE_DEPTH` = 4 documents (1 executing + 3 waiting,
`parser/app.py:84-92, 305-323`) each with a 600 s deadline. The fourth
coordinator's request can wait 3 × 600 s before its Java run starts, past the
840 s client timeout; `parser_client.py:364-375` then raises
`requests.ReadTimeout`, the parse job retries once (`jobs.py:65-71`,
`max_attempts=2`) and joins the same in-flight task, and can still time out
while the parser eventually publishes the artifact nobody claims. Needs four
concurrent deadline-length documents, which ODL timings make rare; with MinerU
the same queue was covered by 2400 s. Fix: either `PARSER_TIMEOUT` ≥ queue depth
× document deadline (2400 + margin; the plan fixed only the job bound at 900,
so this needs a decision), or have the coordinator treat a client
`ReadTimeout` as a `CapacityWait` re-pend instead of an attempt.

### F6 (minor) Heading retention and confidence read the unrepaired PDF for font-repaired sources

`parser/odl/refine.py:52-55` runs `fonts.repair_fonts` and the whole refinement
against the repaired bytes; the lab's `retain_headings` and `chunk_quality`
also used `entry["parsed_pdf"]` (the repaired file). Production
`worker.py:1722` hands `_page_chunks` the spooled original for PDFs. For a PDF
that trips the Type1/ToUnicode gate (`fonts.py:29-44`), the original text layer
decodes Latin glyphs as CJK, so `_source_text` never matches a heading
(`headings.py:134`) and `recall` collapses (`confidence.py:71`): every chunk
on those pages gets "chunk text differs from the source text layer" and a
capture nudge the lab did not have. Fix: have the parser put the repaired PDF
(or its font patch count) in the bundle when `repaired_fonts > 0` and use it
for the two post-passes, or apply `fonts.repair_fonts` in `_page_chunks`
(pure PyMuPDF, seconds).

### F7 (minor) Interim `citations` events still send every retrieved passage to the browser

`agent.py:792-793` (`_run_tools`) still emits a `citations` event with all of
`ctx.citations` after each tool round; the final list replaces it when the
answer streams (`agent.py:382-386, 559-562`). Plan §6: "Retrieved-but-unused
passages … are not sent to the browser." The persisted list is correct; the
transient list is not. Fix: drop the interim event (the frontend only needs
the list once markers appear), or send it with `final: false` and have the
browser ignore non-final lists.

### F8 (minor) Base64 images inflate the context telemetry

`agent.py:317-319` measures `request_messages` (with the injected data URLs)
for `budget.estimated_input_tokens`, and `models.stream_agent_response`
measures the same list for `provider_calls.context_*`
(`accounting.py:134-147` counts one token per three characters of the JSON,
so one 1568 px JPEG q80 of ~300 KB is ~130k "tokens"). Ops context utilisation
and the turn's `estimatedInputTokens` show more than the window after one
capture. Fix: measure `provider_messages` with image parts removed and add
`capture.patch_tokens(width, height)` per attached image (the record already
carries `estimatedImageTokens`).

### F9 (minor) Image tokens are outside the compaction budget

`compact.compact_messages` and `pending.reserve` (`agent.py:275-306`) budget
`messages`, never the injected images; up to 8 captures × ~1.5-2.4k real
tokens are invisible to `usable_input_limit`. A turn that compacts to the edge
of the window and then attaches captures can exceed the provider limit. Fix:
pass `sum(record["estimatedImageTokens"] for record in ctx.captures)` as
`extra` to `compact_messages`.

### F10 (minor) Capture cache key ignores the preview version

`capture.py:102-107` keys the retrieval-host copy by `source_sha256` alone.
Office previews are published per parser version
(`previews/{sha}/{parser_version}/{fingerprint}.pdf`); after a parser bump
the cached preview keeps serving the old LibreOffice render while chunk
regions refer to the new one. Fix: key by `sha256(preview_blob_path or
blob_path)` or include `preview_blob_path`'s basename in the file name.

### F11 (minor) Historical `caption` usage rows lose their label

`src/routes/Billing.tsx:27-40` dropped the `caption` case with the
`billing_kind_caption` message; `usage_events.kind = 'caption'` rows written
before this release now render the raw string "caption" (`default: return
kind`). Fix: keep the `caption` branch and the two message keys for history,
or map it to `billing_kind_llm`.

### F12 (minor) Documentation drift on the deadline start and the queue depth

`openwiki/agentic-retrieval.md` ("600-second hard deadline … starts when its
Java run begins") and `openwiki/deployment-runbook.md` ("begins when its Java
run starts"): `parser/app.py:356-364` starts the timer when the document
leaves the queue, before LibreOffice normalisation. `deploy/docker-compose.ingest-host.yml:64-66`
says "One document executes at a time; four wait"; `app.py:84-86, 310` admits
four in total (one executing, three waiting; `test_a_fifth_document_is_refused_while_four_are_held`).
Also unannotated per plan A2 "Docs": `.todo:21` and
`important-artifacts/office-editing/plan.md:143` still describe MinerU as
current.

### F13 (minor) `resource_credit_rates` decision line points at the wrong file

`human/observability-metering.md` (2026-09-12) cites
`server/migrations/0001_init.sql`; the change is `0008_parse_page_rates.sql`
(decisions-needed #1). Record the answer to #1 and fix the reference.

## Verified

### Contracts (plan A3)

| Contract | Producer | Consumers | Test |
| --- | --- | --- | --- |
| Bundle `capy-parser-bundle-v3` | `parser/app.py:547-629` (`manifest.json` keys `schema`, `parser_version`, `source_fingerprint`, `parse_receipt{id, request_id, measurements}`; `content_list.json`, `document.md`, `preview.pdf` only when it starts `%PDF`, `images/*`; `img_path` → `images/{basename}`) | `parser_client.py:436-541, 578-585, 655-690` | `test_parser_app.py::test_bundle_layout_carries_receipt_preview_and_rewritten_image_paths`, `test_parser_client.py::test_extract_writes_and_validates_the_bundle`, `::test_office_bundle_requires_a_valid_preview` |
| content_list blocks | `parser/odl/adapter.py:20-105` (`text`/`text_level`, `list`/`list_items`, `table`/`table_body`, `image`/`img_path`/`image_caption`, `equation`), `tables.py:831-865` (`footer`), `ocr.py:77-98` (`text` lines) — all with `page_idx` 0-based and page-1000 top-left `bbox` | `chunking.py:486-577`; `_repeated_across_pages` still keys on `page_idx` | `test_odl_refine.py::test_adapter_maps_bottom_left_points_to_page_1000_top_left`, `test_chunking.py`; the extra `_native_*`/`_table_*`/`_recovery` keys pass `parser_client` validation (list/length checks only, `parser_client.py:524-528`) but see F1 |
| Receipt keys | `parser/app.py:499-530` (`_page_count`, `_ocr_page_count`, `_worker_*` as zeros, `_server_parse_ms`, `_execution_ms`, `_queue_ms`, `_slice_count: 1`, `_parse_method: "odl-refined"`, `_source_format`; `_download_ms`/`_upload_ms` added in `_produce_artifact:997-1048`; `_receipt_id` at `_artifact_receipt:703`) | `parser_client.py:73-99`, `worker.py:1274-1344`, billing `db.credits_for_parse_pages` uses `_page_count`/`_ocr_page_count` only | `test_parser_app.py::test_receipt_keeps_the_metering_keys_and_counts_ocr_routed_pages`, `test_parser_client.py::test_success_and_failure_both_record_parser_measurements` |
| Request `POST /file_parse` | `parser_client.py:349-364` (no `parse_method`, by plan A5 step 6) | `app.py:873-889` (400 on schema/version mismatch), 422 `parse_hard_timeout`/`parse_oom`, 429 `parser_capacity`, 503 `parser_runtime_failed`; quarantine marker `quarantine/{fp}.json` with `reason`, `source_fingerprint`, `parser_version`, `detail` (`app.py:726-752`) | `test_parser_app.py::test_artifact_request_rejects_a_foreign_parser_version`, `::test_hard_deadline_quarantines_the_fingerprint_and_restarts`, `test_parser_client.py::test_hard_timeout_response_is_terminally_classified`, `::test_parser_capacity_response_is_classified_without_becoming_terminal` |
| Progress events | `worker.py:1492-1500` (`parsing` 15), `1717` (`indexing` 45), `1724` (`indexing` 55); `captioning` no longer emitted | `sse_events.go`, `hooks.ts` unchanged | none new; existing worker tests |
| Health `GET /healthz` | `app.py:387-421, 783-809`: `active_jobs`, `queued_jobs`, `active_slices` 0, `queued_slices` 0, `oldest_active_slice_s` 0.0, `oldest_queued_slice_s` 0.0, `last_slice_completed_age_s`, `cgroup_oom_kill_events`, plus `pss_bytes`, `cgroup_memory_bytes`, `cgroup_memory_peak_bytes` from `_process_tree_memory` | `ingest/host_sampler.py` (unchanged) | `test_parser_app.py::test_health_keeps_slice_keys_as_zeros` |
| Office preview | `odl/document.py:28-81` (identical to the deleted `mineru_worker.normalize_document`) → `app.py:201-202, 608-626` → `worker.py:_cache_office_preview` (unchanged) | `FileViewer.tsx`, `plan.py`, `rules.go` unchanged | `test_parser_client.py::test_office_bundle_requires_a_valid_preview` |

### Couplings (plan A4)

1. `parser_version` in four identities: fingerprint `parser_client.py:137-143` (no `parse_method`), `pipeline_identity` `worker.py:1262-1268`, quarantine `app.py:716-720`, preview key `worker.py` `_cache_office_preview(parser_version=artifact_version)` unchanged. Handled.
2. `cfg.parse_method` removed from both formats in this release (`config.py`, `parser_client.py:141, 359`, `worker.py:1266`). Handled.
3. Timeout ladder: validator `config.py:283-284` (`PARSER_TIMEOUT < CAPY_PARSE_JOB_TIMEOUT`), Java subprocess timeout `java.py:59-69`, loop deadline `app.py:360-361, 330-349`, lease 180 s `jobs.py:71`. Handled; see F5 for the queue-wait gap.
4. Compose limits and JVM heap: prod 14g/18g/8 cpus with `CAPY_PARSER_JVM_MAX_HEAP` 8g, nonprod 6g/8g with 3g, `start_period` 60 s, cgroup `memory.events` watch kept (`app.py:160-173, 276-303`). Handled.
5. Four-everywhere: `CAPY_PARSE_QUEUE_DEPTH` 4 = `CAPY_PARSE_COORDINATOR_CONCURRENCY` 4; nonprod depth 2 for local + UAT sharing one parser; Redis slots deleted (`slots.py`, `test_parse_slots.py`), 429 → `CapacityWait` (`worker.py:1513-1518`). Handled.
6. Slice columns: kept as zeros/`_slice_count: 1`; Ops card relabelled (`ops/src/pages/ingest-host.tsx`). Handled.
7. `mineru_parse` → `parser_call` (`worker.py:1503`, `test_store_sql.py:1566-1578`); Ops does not key on the old name. Handled.
8. Office normalisation moved to `parser/odl/document.py` before `mineru_worker.py` was deleted. Handled.
9. Browser estimator: `sourceAnalysisCore.ts` `TEXTLESS_CHARS = 40`, `needsOcr = chars < 40`; `MAX_PDF_ANALYSIS_PAGES` untouched. Handled.
10. `CAPY_PARSER` default `opendataloader` (`main.go:176`, composes, tests); stored, never read. Handled.
11. Block vocabulary: ODL dialect emitted, `CHUNKER_VERSION` v6 (`chunking.py:47`). Handled at the block level; the chunk-side fold-in is F1.
12. `figures.py` deleted with captioning; `_IMAGE_TYPES` comment updated. Handled.
13. uid 10001, `/run/capy-parser/{home,work}` created and chowned in the Dockerfile; spool init untouched. Handled.
14. Service name `parser`, port 8090, Docker health in release/watchdog scripts; script comment updated. Handled.
15. Python 3.12 parser vs 3.11 pipeline: `test_parser_app.py` imports `app.py`; `rapidocr`/`numpy` are lazy (`ocr.py:42, 66`), `pymupdf`/`Pillow` are pipeline deps now (`pyproject.toml`, `uv.lock`). Handled.
16. Nonprod 2 cpus / 6 GiB: JVM 3g + RapidOCR + LibreOffice; not measurable here. Config handled.
17. Debian snapshot unchanged (2026-08-28); `openjdk-17-jre-headless` is in bookworm main. Handled.

### Decisions dated 2026-09-12

- MinerU removed, ODL + refined repairs + RapidOCR (PP-OCRv6 small, 2560 px, 8 threads, 0.5, <40 chars, blank pages included): `parser/odl/ocr.py:18-25, 30-35`, `refine.py:48-109`, deletions of `parser/mineru_worker.py`, `parse/slots.py`, `parse/figures.py`. Confirmed.
- Playground under `bench/rag/playground`: out of scope (bench).
- Citations 1..k first-appearance, structured answer: `structured.py:42-110`, `agent.py:357-388, 527-563`. Confirmed (duplicate passage numbers in one claim render `[1][1]`, same as the lab's `render_structured`).
- GLM via TokenHub only, `TENCENT_API_KEY`, thinking low floor, DeepInfra route deleted, default pin for new users: `elitellm/client.py:26-27, 221-231, 739-751, 832-845, 879-881`, `providers.json`, `catalog.go:231-243`, `elitellm_providers.json`, `0009_default_chat_model.sql`. Confirmed. The cassette `pipeline/tests/cassettes/replay/zai__glm_5_3_flash.yaml` in the working tree is already recorded against `tokenhub-intl.tencentcloudmaas.com` and `pipeline/tests/test_model_replay.py` passes 15/15 (the two "known failures" no longer reproduce).
- Figure captioning removed: `plan.py` (`CAPTION_MODES` none/standalone), `rules.go`, `worker.py`, `0007`, `0008` (rate deactivated), frontend toggle and strings. Confirmed.
- capture_page contract and behaviour: `agenttools.go:406-426`, `agent_tools.json` v2, `tools.py:421-491` (require seen page, 8 cap `cfg.captures_per_turn`, no citation, names existing numbers), `capture.py:88-110` (preview PDF for Office, refuse text/store-only), JPEG on `ToolContext.pending_images`, never in `messages` or `messages.metadata` (`agent.py:312-316`; activity carries `{page, bbox, bytes}` only, `agent.py:682-687`). Confirmed. Images are re-attached on every later request of the same turn, which matches the playground (`playground.py:329`).
- Extraction confidence stored and shown below 0.9, OCR pages fixed 0.5: `confidence.py`, `0006`, `search.py:88-92`, `cfg.confidence_note_below`. Confirmed.
- Prompt = playground `structured-glm-tencent` minus locale line plus structured rule; caps 8/2/16: `prompts/chat.py`, `limits.py:15-17`, `cfg.agent_max_steps` 8. Confirmed (text compared with `bench/rag/playground/configs/structured-glm-tencent.json`).
- Structured JSON answer, `json_object` only on tool-less calls, one repair, stream-parsed prose, persisted list = used passages: `agent.py:344`, `_repair_answer`, `StreamRenderer`. Confirmed except F2; a json-shaped answer that never closes keeps the streamed prose without a repair call (documented in the agent docstring; `test_unfinished_json_answer_keeps_the_streamed_prose`), which is a defensible reading of "one repair call" since prose was already shown.
- `digital_parse_page` and `ocr_parse_page` 1.0 credit, `figure_caption_call` deactivated: `0008`; `db.credits_for_parse_pages(40, 2, 1_000_000, 1_000_000)` = 40,000,000 micros = 40 credits; browser policy mock and Go `ingestResourceKeys` no longer require the caption rate. Confirmed (see F3 for the migration's re-run hazard).
- `human/deployment-runbook.md` (Coolify layer cache, Ops edge probe): unrelated to this change; the parser Dockerfile keeps `ARG RELEASE_SHA` below the cacheable layers as that decision requires.

Older decisions now stale (records for the orchestrator to annotate, not code defects):

- `human/observability-metering.md:6` — GLM routed to DeepInfra as `zai-org/GLM-5.3-Flash` on `DEEPINFRA_API_KEY`: superseded by the 2026-09-12 TokenHub decision; the code no longer does this.
- `human/observability-metering.md:3` — captioning slot "(ingest figure captions and standalone image uploads)": figure captions no longer exist.
- `human/authorization-permissions-lifecycles.md:3` — "different MinerU crops may be captioned independently": no crops are captioned any more (plan A2 flagged this line).
- `human/agentic-retrieval.md:2, 29` — caption artifact writes and parsed-image caption reuse cite `parse/figures.py` and figure captions that are gone.

### Removal grep (outside `bench/`)

`mineru`/`MinerU`: only `.todo:21`, `important-artifacts/office-editing/plan.md:143` (F12), historical comments in `test_ingest_plan.py:63`, `0008_parse_page_rates.sql:1`, `openwiki/agentic-retrieval.md:685`, and the `human/` records above. `parse_method`: only the `_parse_method` receipt key (A3, justified at `app.py:502-503`). `CAPY_PARSE_METHOD`, `CAPY_PARSE_SLOTS`, `slice_pages`, `CaptionImages`, `SupportsFigures`, `supportsFigures`, `parseMethod`, `PARSER_SLOT_TTL`, `CAPY_PARSE_SLICE_TIMEOUT`, `CAPY_MINERU*`, `mineru_parse`, `DEEPINFRA_GLM`: no hits. `caption_images`: only `0001`/`0007` and docs. `figure_caption_call`: only `0001`, `0008` and docs. `zai-org/GLM`: `human/observability-metering.md:6` and one "history" note in the wiki.

### Parser fidelity (`parser/odl/*` against `bench/parsers/scripts/*`)

Diffed function by function: `adapter.py` = `compare_opendataloader.odl_content_list/node_text`; `styles.py` = `experiment_odl_source_styles.annotate` (receipts dropped); `order.py` = `experiment_odl_reading_order.repair/demote_rotated(demote=False)/split_continuations`; `hidden.py` = `experiment_odl_ocr_disagreement.source_facts/gutter/column_order/recover_hidden_ocr_order`; `headings.py` = `experiment_odl_heading_context.source_headings/rewrite(arm="structure")`; `context.py` = `experiment_odl_native_tables.native_spans/contextualize(strict=False)`; `table_html.py` = `structured_recovery.Table/checked_spans/table_html`; `lists.py` = `experiment_odl_list_geometry.repair_list_geometry` and `experiment_odl_list_text.restore_items/repair_lists` (the `proxy_index in evidence` test became `proxy["text"] != original["text"]`, equivalent because an overprint decision exists iff the text changed); `source_text.py` = `experiment_odl_native_text.*`; `exponents.py` = `experiment_odl_exponents.*`; `columns.py` = `experiment_odl_column_continuation.*` with `canonical` from heading retention; `geometry.py` = `experiment_odl_table_geometry.text_lines/row_groups/horizontal_rules/table_from_region/as_block/row_label_spans` with `NUMBER` set to the integration module's `VALUE` (the lab patched it in for every `recover`); `tables.py` = `experiment_odl_table_integration.select_regions/source_context/row_scope/backgrounds/recover/simple_table/parenthetical_continuations/conservative_shape/watermark_blocks/removed_coverage/replace_tables` plus `refine_odl_output.mark_footer_tables`; `ocr.py` = `experiment_odl_selective_ocr.line_blocks/merge` with the September 8 RapidOCR parameters; `fonts.py` = `experiment_odl_font_recovery.explicit_encoding/contradiction/unicode_cmap/audit` gate. Stage order in `refine.parse_pdf` matches `measure_odl_native_pipeline --variant refined` followed by `refine_odl_output.refine(table_recovery=True)` and the OCR merge. The only semantic differences are performance-neutral: `TEXT_PRESERVE_IMAGES` cleared on `get_text("dict"/"rawdict")` calls (image blocks carry no `lines`, so the line/span sets are identical), `if len(rules) < 2: continue` and lazy `text_lines` in `recover_tables` (a bucket needs two rules to become a region), `if not eligible: continue` in `watermark_blocks`, early `return False` in `removed_coverage`. `doc.tobytes()` replaces `document.save(path)` for the repaired PDF; geometry is unaffected. Chunk-stage divergence is F1; unrepaired-PDF post-passes is F6.

### Agent loop checks (brief item 6)

Images only in `request_messages` (never `messages`, history, checkpoint or `messages.metadata`); `response_format=JSON_OBJECT` iff `tools_off` (`agent.py:344`) and in the repair call; repair path streams nothing before the repaired text; renumbering assigns numbers in first-appearance order across in-text markers and `passages`, held-back partial markers (`PARTIAL`) and trailing whitespace mirror `render_structured` (property test `test_stream_renderer_random_chunking_property`); citations events precede the delta that introduces a new marker and the final list is emitted unless the last streamed list already equals it; `_record_searches` flags from `cited_order`; already-cited page rule and `require_seen_page` always on; cap counts successful captures only (as the playground); malformed JSON mid-stream keeps streamed prose (see F2 for the complete-but-wrong-shape case); terminal tools-off call gets `json_object`; compaction never sees images (F8/F9 for the budgets), and the checkpoint summarizer folds history content only.

## Test runs

| Command | Result |
| --- | --- |
| `pnpm test:pipeline:offline` | **1 failed**, 589 passed, 120 deselected: `pipeline/tests/test_capture.py::test_capture_page_is_offered_with_the_read_operation` — `FileNotFoundError: [Errno 2] No such file or directory: 'pipeline/generated/agent_tools.json'` (F4) |
| `uv run --extra test pytest pipeline/tests/test_model_replay.py` | 15 passed (the `zai/glm-5.3-flash` cassette in the tree is already TokenHub-recorded) |
| `pnpm test:go` | all packages `ok` |
| `go vet ./...` (in `server/`) | clean |
| `pnpm test` | 63 files / 298 tests passed (`src`), 1 file / 4 tests passed (`bench/editor`) |
| `pnpm test:deployment` | 11 + 13 + 2 unittest cases and 3 node tests passed |
| `pnpm typecheck` | clean |

## Operational notes for the UAT deploy (not defects)

- `model_capacities` has no row for the new transport `tencent:glm-5.3-flash`; `accounting.model_capacity` raises "model capacity is not configured" until an operator creates it in Ops (documented in `openwiki/observability-metering.md:855-859`). Because `0009` makes GLM the default pin for new accounts, do this before the first new sign-up on UAT, together with `TENCENT_API_KEY` on the Coolify `retrieval`/`ops` resources and the ingest-host envs (`deploy/env-manifest.json`).
- The four `decisions-needed.md` questions were treated as pending; the code matches the "implemented" description in each.
