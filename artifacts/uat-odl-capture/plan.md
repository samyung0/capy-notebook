# UAT plan: refined ODL parser, capture_page, structured citations

Status: implemented in the working tree, uncommitted; ODL follow-ups continued
on 2026-09-13. The review and repair history is in `review-1.md`, `review-2.md`
and `fixes-1.md` through `fixes-4.md`. The latest report separates implemented
repairs, frozen validation and measured limits. Not yet deployed to UAT.
Decisions are in `human/agentic-retrieval.md`,
`human/observability-metering.md` and `human/deployment-runbook.md`.

Deviations from the text below, decided during implementation: migrations are
forward-only files `0006` to `0009` with `0001_init.sql` frozen; the lab packer
(frozen furniture, isolated native tables) is in production chunking with
`refinement.json` mandatory in every bundle; `PARSER_TIMEOUT` is 2520 s and
`CAPY_PARSE_JOB_TIMEOUT` 2700 s (queue depth × deadline plus margin) instead of
900; the catalog chat slot default moves to GLM as well as the users column
default; the font-repaired PDF ships as `parsed.pdf` for heading retention and
confidence; standalone image uploads bill model tokens only; no interim
citations events reach the browser.

The September 13 follow-ups use parser identity `odl-2.5.7-refined-rapidocr-v3`
and chunker v9: unique short prose survives, source-proved folios are filtered,
mixed native tables retain scoped context/styles, fresh OCR uses guarded
PP-DocLayoutV3 ordering, and a persistent parse child leaves the API able to
supervise OOMs and deadlines. See [the implementation and local verification
report](../../bench/parsers/reports/2026-09-13-odl-implementation.md) and
[the frozen new-source validation](../../bench/parsers/reports/2026-09-13-odl-repair-validation.md).
The 610-page textbook now publishes below the unchanged 4,096-entry bundle cap
after byte-identical image deduplication. The new-source checks retain known
unresolved table and ordering cases. These results are not a UAT readiness sign-off.

Before UAT traffic: set `TENCENT_API_KEY` on the Coolify resource and in
`deploy/.env.uat` (`pnpm env:push`), and create the `tencent:glm-5.3-flash`
row in `model_capacities` through Ops; `0009` makes GLM the default for new
accounts, so both must exist before the deploy completes.
Source of the numbers: [capture-page playground report](../../bench/rag/reports/2026-09-12-capture-page-playground.md).

## What changes, in one table

| # | Workstream | Today | Target | Depends on |
| --- | --- | --- | --- | --- |
| 1 | Parser | MinerU 3.4.5 CPU service, formula/table/OCR models, four slice lanes | OpenDataLoader Java + refined repairs + selective RapidOCR on text-less pages; no figure captioning | nothing |
| 2 | Extraction confidence | none | per-chunk score stored at ingest, shown on passages below 0.9 | 1 |
| 3 | capture_page tool | playground only | production tool in the Go contract, Python handler, retrieval-host PDF cache, image injection into the model request | 2 for the nudge to work; can ship without |
| 4 | Chat model route | zai/glm-5.3-flash via DeepInfra | same pin via Tencent TokenHub, thinking low | nothing |
| 5 | System prompt and limits | production prompt; 12 / 4 / 12 | the playground prompt (capture rule baked in, no addon); 8 / 2 / 16 planning / per-response / per-turn, 8 captures per turn | 3 |
| 6 | Citations | pre-assigned numbers, answer cites a subset, gaps visible | structured JSON answer, renumbered 1..k in the prose, list holds only used passages, captures of already-cited pages add no entry | 3, 5 |
| 7 | Credits | digital page 31, OCR page 52, figure caption 2 per call | digital 1.0, OCR 1.0; caption rate retired | 1 |
| 8 | MinerU removal | — | delete the service, its config, its docs and tests | 1 live on UAT |

Rough order: 1 and 4 in parallel, then 2, 3, 5, 6 together (they share the agent
and the prompt), 7 with 1, 8 last.

## 1. Parser: refined ODL with selective OCR

What the lab ran and what production must reproduce. The bench code is the
spec; the work is moving it out of `bench/` into `parser/`.

Pipeline per document, as measured on the 663-page lab corpus:

1. Office normalisation through LibreOffice, unchanged (today inside the MinerU worker).
2. OpenDataLoader Java on the PDF (53 s per 430 pages, 116 s for the 610-page textbook, one process).
3. Refinement, PyMuPDF-based, from `bench/parsers/scripts/refine_odl_output.py --arm tables`: bind Java JSON to the parsed PDF, list geometry, glyph proofs, scientific exponents, column continuations, fully covered source tables, orphan heading retention, footer ancestry. Plus the heading-context `structure` arm and the hidden-OCR-layer reorder. Selected arm: cluster detection and header/footer inclusion kept.
4. Selective OCR: pages with under 40 native characters rendered at 2560 px and passed to RapidOCR (PP-OCRv6 small det/rec, mobile cls, 8 threads, text score 0.5); lines merged as text blocks in page-1000 space after the page's existing blocks. 11 of 663 pages, about 15 s CPU total, 0.55 s model load. Spec: `bench/parsers/scripts/experiment_odl_selective_ocr.py`.
5. Bundle: the same `content_list.json` shape the chunker reads today, image blocks kept with `img_path` (captions are no longer generated, so the ingest worker skips the caption step; the figure bytes still ship so a later viewer or capture can use them).
6. Chunking unchanged (`pipeline/retrieval/chunking.py`), with the ODL packer's furniture and heading retention folded in.

Service shape: one persistent parser container (OpenJDK 17 as in the lab
image `capy-java-native:20260909`, the `opendataloader-pdf==2.5.7` Python
package whose CLI wraps the pinned jar, PyMuPDF 1.28.2, rapidocr 3.9.2,
onnxruntime, the three PP-OCRv6 ONNX models baked into the image), same `POST /file_parse` and `/healthz`
contract the coordinator speaks today, same shared-spool handoff, same receipt
fields (`parse_pages`, `parse_ocr_pages` now meaning "pages routed to RapidOCR").
Slicing: ODL handles the 610-page textbook in one process at under 2 GiB, so the
four-lane page slicing goes; keep one worker process with a job queue of depth 4,
`/healthz` still emitting the slice keys as zeros so the host sampler, its table
and the Ops schema stay untouched. Office normalisation (`normalize_document`,
`pdf_page_count`) moves out of `mineru_worker.py` into the new module first.
The Java runner gets its own hard deadline so `parse_hard_timeout` quarantine
keeps working. Timeouts: `CAPY_PARSE_JOB_TIMEOUT` drops from 3600 to 900 and
the ladder validator in `config.py` moves with it; the slice timeout, the Redis
slot gate and `CAPY_PARSE_METHOD` go in the same release as the version bump,
because the method knob is part of the fingerprint format.

Parser identity: `pipeline_identity` carries the parser version, so every
existing UAT source re-parses on next refresh and no MinerU artifact is a donor
for an ODL parse. Expected; UAT has one file.

Settled: figure captioning is removed entirely (no caption stage, no upload
toggle, `NormalizeCaptionImages` and the `caption_images` column go, the
caption cache stays only for standalone image uploads if that path keeps a
description, otherwise it goes too); the 40-character text-less threshold
stands; Office previews keep going through LibreOffice inside the parser
container.

## 2. Extraction confidence

Computed once per chunk at ingest, stored, shown. Spec: `bench/rag/playground/scripts/chunk_quality.py`.

- Signals: agreement of the chunk text with the cited pages' text layer (words
  for spaced scripts, characters for CJK), text layer present at all, pipe-table
  row consistency, page coverage of the index. No captions to cap any more, so
  the caption rule goes.
- Storage: two columns on `rag_chunks`, `confidence real` (null when the source
  has no page model) and `confidence_reasons text[]`, written by the ingest
  worker after chunking, copied on donor reuse. Go migration `0006`.
- Display: `Passage.location()` appends ` [extraction confidence 0.72: reasons]`
  when the score is below 0.9, matching the prompt rule in workstream 5. The
  threshold lives in `pipeline/config.py` as `CAPY_CONFIDENCE_NOTE_BELOW` (0.9).
- Cost: PyMuPDF text extraction per page inside the ingest worker, seconds per
  document; the worker image gains `pymupdf`.

Limits to write down in the wiki: it cannot see reading-order or
cell-association errors when every word is present, and an OCR text layer
counts as a text layer (so a scanned page that RapidOCR handled scores by
agreement with itself: always high). For OCR-routed pages the reason
"page text came from OCR" should be attached with a fixed score of 0.5 so the
nudge still fires; the parser marks those pages in the bundle.

## 3. capture_page in production

Spec: `bench/rag/playground/scripts/capture.py`, mode `pixels`, `citation: page`.

Contract (Go, `server/internal/agenttools`): name `capture_page`, read tool,
`RequiredOperations: source.read`, arguments `file_id` (string), `page`
(integer ≥ 1), `bbox` (optional, four numbers 0-1000). Regenerate
`pipeline/generated/agent_tools.json`; contract version bumps to 2.

Handler (`pipeline/retrieval/tools.py`):

- Scope check as `read_document`; refuse when no passage shown this turn cites
  that page (`require_seen_page`), refuse past `CAPY_CAPTURES_PER_TURN` (8).
- PDF access: resolve `files.preview_blob_path` (Office) or `blob_path` (PDF);
  refuse text sources and `parse_mode = none` files with `unsupported_format`.
  Download from B2 into a retrieval-host cache keyed by `source_sha256`
  (`CAPY_CAPTURE_CACHE_DIR`, LRU by size, `CAPY_CAPTURE_CACHE_MAX_BYTES`, say
  2 GiB). One 30 MiB intra-cloud GET per file, then 0.05 to 0.4 s per render.
  Render with PyMuPDF at `CAPY_CAPTURE_MAX_EDGE` (1568) to JPEG q80.
- Result: when passages already cite the page, the tool text names their
  numbers and adds no citation (measured: the model then cites those). When
  none does (only possible with `require_seen_page` off) a passage with the
  rendered box as region is added.
- Image transport: the JPEG rides in a user message placed after the last tool
  result of that step (chat-completions tool messages carry text only), or an
  Anthropic `image` block on that route. This lives in `models.stream_agent_response`
  as a per-turn "pending images" list on `ToolContext`; images are dropped from
  history after the turn and never persisted in `messages.metadata`.
- Cost: about 2,400 input tokens per capture on GLM, billed through the
  ordinary LLM usage path; no new resource rate.
- Telemetry: `toolCallsByName.capture_page` already lands in the turn
  telemetry; add `captures` (page, bbox, bytes) to the activity block so the
  frontend can show "looked at page 4".

Frontend: a `capture_page` row in the activity list with the page label; no
image display in v1. i18n keys for the tool name in `messages/en.json` and
`messages/zh.json`.

Why server-side and not the browser: the pixels must be inside the provider
request that the Python agent builds mid-turn; a browser round-trip would tie
every turn to a live tab (generate workflows, closed tabs, mobile), and the
browser's cached PDF is on the wrong side of the wire.

## 4. GLM-5.3-flash via Tencent TokenHub

Today `zai/glm-5.3-flash` is a catalog exception routed to DeepInfra
(`server/internal/models/catalog.go:233`, `pipeline/elitellm/client.py`
`_is_routed_zai_glm`, `providers.json` `platformEnv: DEEPINFRA_API_KEY`).

Change: route the same pin to `https://tokenhub-intl.tencentcloudmaas.com/v1/chat/completions`
with `TENCENT_API_KEY`, wire model `glm-5.3-flash`, request body as `zai_request`
today (`reasoning_effort`, tools, `stream_options`). Both Go (`CredentialEnv`,
`transportRef`) and Python routing change together; the catalog row, the user
pins and the certification key stay `zai/glm-5.3-flash`. Add `TENCENT_API_KEY`
to `deploy/env-manifest.json`, `deploy/.env.uat`, the Coolify resource and the
ingest-host queue env (captioning is gone, so only the retrieval service and the
gateway need it).

Measured: 2 to 3 times lower per-call latency than DeepInfra (5.5 to 9.9 s
against 11.8 to 27.6 s on the same turn), `reasoning_tokens` reported in usage,
thinking cannot be disabled (`low` is the floor, already the catalog default).

Re-certify: `pnpm test:pipeline:replay` cassettes for `zai/glm-5.3-flash` were
recorded against DeepInfra; re-record through TokenHub so the certification
gate (`AgenticLoopCertified`) reflects the live route.

Default chat model: `users.chat_model_provider_slug` / `chat_model_slug`
defaults move to `zai` / `glm-5.3-flash` (migration alters the column
defaults; existing rows keep their pin). GLM is the model that read scans
correctly; DeepSeek flash vision misread every cell of the same crop.
Single route: the DeepInfra transport for this pin is deleted, no failover.

## 5. System prompt and limits

Prompt: replace `SYSTEM_PROMPT` in `pipeline/prompts/chat.py` with the text of
`configs/structured-glm-tencent.json` `system_prompt`, minus the hard-coded
English locale line (that stays `response_language_rule(locale)`), plus the
structured-answer rule from workstream 6. No addon mechanism; the capture rule
is a bullet in the base prompt. The tool description in the Go contract keeps
the short usage note.

Limits (`pipeline/retrieval/limits.py`, `CAPY_AGENT_MAX_STEPS`):

| Limit | Today | Target |
| --- | ---: | ---: |
| `PLANNING_RESPONSES` | 12 | 8 |
| `TOOLS_PER_RESPONSE` | 4 | 2 |
| `TOOLS_PER_TURN` | 12 | 16 |
| captures per turn | — | 8 |

`TOOLS_PER_TURN` is set to the product 8 × 2 on purpose: planning responses
and the per-response cap are the only binding limits, and a turn that uses
every call ends on the tools-off last response rather than on a
`limit_reached` refusal.

Wiki: `openwiki/agentic-retrieval.md` chat-agent section, the caps line and
the tools table.

## 6. Citations

Spec: `bench/rag/playground/scripts/citations.py`, mode `structured`.

- The final answer is `{"answer": [{"text": "…", "passages": [n, …]}, …]}`,
  requested by a prompt rule; `response_format: json_object` is set only on
  calls that offer no tools (with tools offered, GLM under `json_object` skipped
  the search and invented an answer). One repair call when the answer does not
  parse; if it still fails, the raw text is the answer and the citation list is
  empty (the failure is logged with the raw text).
- The agent renders the prose itself: claims joined by blank lines, each with
  `[k]` markers numbered 1..k in first-appearance order, and emits a final
  `citations` event (`final: true`) holding only the used passages in that
  order. Retrieved-but-unused passages stay in `rag_search_events` as
  `cited=false`; they are not sent to the browser.
- Persistence: `messages.content` is the rendered prose, `citations` the final
  list. Nothing else changes in Go; `FinalizeAssistantMessage` already stores
  the last citations event it saw.
- Streaming: the model streams JSON, not prose. The agent stream-parses the
  `answer[].text` fields as they arrive and emits `block_delta` events with
  the prose (claim by claim, markers appended when the claim's `passages`
  array closes), so the browser keeps today's streaming answer and nothing
  changes in `useChatStream`. The raw JSON is never sent to the browser.
- Checkpoint summaries already treat historical numbers as answer-local, so
  renumbering changes nothing there.
- Captures of already-cited pages add no citation (workstream 3).

## 7. Credits

`resource_credit_rates`: insert version 2 rows `digital_parse_page` 1.0
credit (1 000 000 micros) and `ocr_parse_page` 1.0 credit, active, and
deactivate version 1; deactivate `figure_caption_call` (no caption step). Seed
in `server/migrations/0001_init.sql` for fresh databases, an Ops "new active
version" action on UAT for the live rows (enqueued jobs keep the snapshot they
were priced at). The upload dialog's digital/OCR split
(`src/features/workspace/sourceAnalysisCore.ts` `ocrPageCount`) keeps working
and now prices both sides the same; simplification to one rate is a later
cleanup if wanted.

## 8. MinerU removal

Mapped by a read-only Opus 5 pass over the whole repository (`bench/` excluded;
its ~60 MinerU references are history and the spec for the replacement). The
full report is the appendix. What it changes about the plan above:

- **Office normalisation lives only in `parser/mineru_worker.py`**
  (`normalize_document`, `pdf_page_count`, `OFFICE_SUFFIXES`,
  `CAPY_OFFICE_CONVERT_TIMEOUT`). It moves into the new parser module before
  that file is deleted, or every docx/pptx/xlsx upload breaks: the client
  rejects Office bundles without `preview.pdf` and the worker raises.
- **The parser version sits in four identities**, not one: the artifact
  fingerprint, `rag_contents.pipeline_identity` (donor matching), the
  quarantine marker key and the Office preview key. The switch invalidates all
  four for every existing source; UAT has one file, so this is a non-event
  there, but it is a full re-parse on any populated database.
- **`CAPY_PARSE_METHOD` is baked into the fingerprint and pipeline identity
  string formats.** Removing the knob changes the identity format itself; do
  it in the same release as the parser switch, never after.
- **The timeout ladder is validated at process start**
  (`config.py:286-293`: slice < parser < slot TTL < job timeout) and asserted
  by `test_parse_time_budgets.py`. Every env file, compose default,
  `env-manifest.json` and the validator move together. The per-slice deadline
  is today's only hard stop on the parser process; the Java runner needs its
  own deadline or `parse_hard_timeout` quarantine never fires again.
- **Slice fields are persisted and read in seven places**
  (`ingest_job_attempts.parse_slices`, five `ingest_host_samples` columns and
  their rollups, Go `ops/types.go`, `ops/read_store.go`, `ops/privileges.go`,
  `deploy/ops-roles.sql` grants, the Ops zod schema). Cheapest path: the new
  `/healthz` keeps emitting those keys as zeros and no schema moves; the Ops
  "MinerU pool" card gets relabelled.
- **The `mineru_parse` stage name is stored in `stage_timings`** and shown by
  Ops; rename to `parser_call` and accept that historical rows keep the old key.
- **The block vocabulary is a MinerU dialect** (`chart`, `aside_text`,
  `discarded`, `page_footnote`, `text_level`, `list_items`, `table_body` HTML
  with `rowspan=1 colspan=1`, `<sub>/<sup>`, LaTeX spacing). The ODL adapter
  already emits this shape in the lab (`refine_odl_output.py`); if it drifts,
  `CHUNKER_VERSION` bumps and donors invalidate again.
- **The browser's OCR estimator** (`sourceAnalysisCore.ts`, 800/400
  character thresholds, 0.7 image coverage) models MinerU's `auto` rule. With
  both rates at 1.0 the estimate is rate-insensitive, so the heuristic can
  simply become "under 40 characters" to match the server, and the
  "OCR pages" strings stay truthful.
- **Redis parse slots** (`slots.py`, `CAPY_PARSE_SLOTS`, four-everywhere with
  coordinator concurrency and parser lanes) exist to match four MinerU
  slices. Drop them; the parser's own 429 `parser_capacity` already feeds
  `CapacityWait` in the worker.
- **uid 10001, service name `parser`, port 8090, cgroup v2 OOM watching** are
  load-bearing for the spool init, the release and watchdog scripts, and the
  `parse_oom` quarantine; keep all four in the new container. JVM heap must
  be sized inside the compose memory limit (6 GiB nonprod) so the kernel, not
  the JVM, is what kills a runaway parse.
- **Debian snapshot pin** (`parser/debian.sources`, 2026-08-28) may lack
  the JDK package; moving the pin changes the LibreOffice build and therefore
  Office preview bytes, which donor matching compares.

Removal order (from the report, condensed): freeze the contracts in §3 of the
appendix as acceptance tests; build the new parser module with normalisation
and a hard deadline; rewrite the `app.py` runtime around a depth-4 document
queue; new Dockerfile; bump `PARSER_IMPLEMENTATIONS`; remove
`CAPY_PARSE_METHOD`; retire slicing config and resize the timeout ladder;
delete the slot gate; rename the stage; align health/sampler/Ops; delete the
MinerU files and port the reusable `test_parser_app.py` cases; compose,
ansible, release script; the Go `CAPY_PARSER` label; frontend copy and
estimator; docs.

## Verification on UAT

1. Parser: upload the three fixtures (`lecture_plus_scan.pdf`, the NIST shot
   paper, `jp_llm2.pptx`); confirm receipt pages, OCR page count 2 for the scan
   canary, no caption calls, and the newspaper scan searchable.
2. Confidence: the NIST Table 2 chunk carries a note below 0.9; digital
   chunks carry none.
3. Chat: the twelve-question batch from the report through UAT's
   `/chat/stream` (a `batch.py` target pointing at UAT); expect the same eleven
   of twelve, captures visible in activity, citations 1..k with no gaps.
4. Credits: a 40-page upload with 2 scanned pages bills 40 credits.
5. Editor perf and the deterministic UAT gate unchanged.

## Decisions taken 2026-09-12

- Captioning removed entirely, not opt-in.
- Default chat pin for new users becomes `zai/glm-5.3-flash`.
- Structured answers stream-parse into prose; no buffering.
- Tencent TokenHub is the only route for GLM; DeepInfra transport deleted.
- Selective OCR threshold stays at 40 native characters, blank pages included.

## Appendix: MinerU blast radius

Report from the read-only mapping pass, verbatim except for path shortening.
Line numbers are as of 2026-09-12.

### A1. Files to delete outright

| Path | Why MinerU-only |
| --- | --- |
| `parser/mineru_worker.py` | The MinerU `do_parse` adapter: `parse_slice`, `page_slices`, `merge_slices`, `_slice_uses_ocr`, `MINERU_*`, `normalize_parse_method`. Exception: `normalize_document()` (lines 61-114, LibreOffice, `OFFICE_SUFFIXES`, `OFFICE_PREVIEW_MAX_BYTES`, `CAPY_OFFICE_CONVERT_TIMEOUT`, returns `NormalizedDocument`) and `pdf_page_count()` must move first. |
| `parser/requirements.in`, `parser/requirements.txt` | `mineru[pipeline]==3.4.5`, CPU torch; 2,529-line lock. |
| `pipeline/tests/test_mineru_worker.py` | Tests slicing helpers only. |
| `pipeline/tests/test_parse_slots.py` | Redis slot gate sized to four MinerU slices. |
| `pipeline/tests/test_parse_time_budgets.py` | Asserts the slice/slot timeout ladder. |
| `pipeline/pipeline/parse/slots.py` | Redis ZSET admission at `CAPY_PARSE_SLOTS`; parser 429 already backstops (`parser_client.py:391-396`). `CapacityWait` stays (audio uses it, `worker.py:1509,1878`). |
| `parser/__pycache__/*`, `pipeline/pipeline/parse/__pycache__/{mineru_lite,modal_parser,host_sampler}.pyc` | Stale, untracked. |

### A2. Files to change

**Parser service.** `parser/app.py`: imports 32-45; `PARSER_IMPLEMENTATION` line 49 (must equal `parser_client.py:49`); `_dependency_versions` 58-74; `CAPY_MINERU_SLICE_PAGES`, `CAPY_PARSE_SLICE_TIMEOUT`, `CAPY_PARSE_CONCURRENCY` 90-101; `Document.parse_method` 119-124; `_QueuedSlice`/`_DocumentExecution` 153-170; `_is_broken_process_pool` 189-204; `ParserRuntime` 207-530 (slice workers, OOM monitor, `_expire_slice`, `_parse_admitted`); `_measurements` 608-638 (keep key names); `/healthz` 904-963; `parse_method` at 986 and 1147; MinerU strings 264-266, 491, 520, 886-888. Keep: `ARTIFACT_SCHEMA = "capy-parser-bundle-v3"`, `_bundle_bytes` 655-737, `_artifact_parse`/`_artifact_task`/`_produce_artifact` 1030-1232, quarantine 814-861, `_shared_path`, `_read_source`, `_authorized`, both `/file_parse` routes, psutil sampling. `parser/Dockerfile`: MinerU/torch env 11-23, torch deps 35-38, `pip install --require-hashes` 45-47, COPY 51, `/models` dirs 54; keep LibreOffice + fonts 31-34, 39-41, `USER parser` uid 10001. `parser/debian.sources`: check the snapshot has the JDK 17 package.

**Pipeline.** `parse/parser_client.py`: docstring 10-12; `PARSER_IMPLEMENTATIONS` 49 (flows into `parser_version` 102-107, `artifact_identity` 137-143, quarantine 294, validation 521, extract 581, publish 617, extract 661); identity string 141 includes `cfg.parse_method`; request body `parse_method` 359; `_record_measurement` 73-99 (keep keys); comments 412-413, 630. Keep error classes, quarantine reading 284-310 and 386-396, bundle validation, B2 cache, `sweep_local_spool`. `parse/__init__.py:1`. `parse/figures.py` goes with captioning (`_IMAGE_TYPES` 52 must match `chunking.py:53` until then). `config.py`: 119 `PARSER_TIMEOUT`, 120-122 `CAPY_PARSE_SLICE_TIMEOUT`, 129 `PARSER_SLOT_TTL`, 130 `CAPY_PARSE_JOB_TIMEOUT`, 132-134 `CAPY_PARSE_SLOTS`, 135-137 `CAPY_PARSE_METHOD`, 69-71 coordinator concurrency, validators 257-267 and 286-293. `ingest/worker.py`: docstring 14; `_set_stage("mineru_parse")` 1511; slot acquire/release 1497-1526; `_pipeline_identity` 1262-1271 (drops `cfg.parse_method`); `record_job_parse_metrics(slices=)` 1288-1296; metadata `parseMethod` 1338; caption branch 1731-1771; slot wait message 1877-1880. `ingest/parse_worker.py:5`. `ingest/capacity.py` (nonprod flock, keep). `jobs.py:67-77` parse policy and comment, `CapacityWait` docstring 29. `ingest/source_text.py:4`. `ingest/host_sampler.py:193-225, 269-299, 305-366` (health keys → `ingest_host_samples`). `ingest/telemetry.py:63-66` (keep). `obs.py:360, 401, 432` (`ParseUsage.slices`). `store/db.py:547-575` (keep columns, send 0). `pipeline/Dockerfile:2-3` comment. `pyproject.toml:31` comment.

**Go.** `server/cmd/api/main.go:176` `CAPY_PARSER` default "mineru" → `httpapi/server.go:90,113,121` → `store/jobs.go:22,57-66`, `uploads.go:124-243`, `source_imports.go:672-750`, `internal_import.go:409`, `share.go:502,667,689,967-970`; written to `files.parser` (`0001_init.sql:257`) and never read. `sourceupload/rules.go:13` comment; `ParseModeFast = "fast"` survives (`plan.py:199` requires it). `store/jobs.go:18-19` comment. `httpapi/huma_sources.go:87-97` `SupportsFigures` (goes with captioning). `httpapi/file_preview_test.go:29,137` literal. `0001_init.sql`: `files.parser` 257, `ingest_job_attempts.parse_slices` 1130, `parser_*_milliseconds` 1131-1134, `ingest_host_samples` slice columns 2232-2250, rollups 2300-2315, rate seed 1050-1051. `ops/types.go:84-120,129,217`, `ops/read_store.go:304-306,327,394-397,425-428,582,607`, `ops/privileges.go:239-243,301-303`, `deploy/ops-roles.sql:160-164,180`.

**Frontend.** `src/api/hooks.ts:1196` JSDoc. `src/features/workspace/sourceUpload.ts:5-7,38-88` (`supportsFigures` goes). `AddSourceDialog.tsx:438-475, 917-936, 992-1060`. `sourceAnalysis.ts:29-43,67-83`. `sourceAnalysisCore.ts:11-17,94-142` (`GOOD_TEXT_CHARS`, `THIN_TEXT_CHARS`, `SCAN_IMAGE_COVERAGE` → `needsOcr`). `src/mocks/sourceUploadPolicy.ts:90-112` rates 31/52 and `supportsFigures`; `src/mocks/handlers.ts:2889`. `messages/en.json`, `zh.json`: `source_fast_parsing` 426, `source_no_parsing` 425, `source_analysis_result` 437, `source_analysis_summary` 438, `source_analysis_unsupported` 436, `source_parse_hint` 472 ("can describe the images it finds"), `files_pending`/`files_pending_named` 678-679, `billing_kind_parse` 254, `billing_kind_caption` 253, `settings_llm_keys_hint` 139 ("parse, captions"). `src/lib/observability.ts:122`. Regenerate `src/api/gen` if the policy shape changes.

**Ops dashboard.** `ops/src/pages/ingest-host.tsx:240-243, 297, 231, 632, 636-639, 665-668`. `ops/src/api.ts:174-267` zod slice fields. `costs.tsx:156-169,417-418,533,583`, `users.tsx:387,428` (`parseOcrPages` labels stay valid).

**Deploy / CI.** `deploy/docker-compose.ingest-host.yml`: parser service 55-121 (env 82-84, volume 99 and 254-255, limits 101-103, healthcheck 116), `x-pipeline-env` 20-27, coordinator 135, sampler 243; keep `parse-spool-init`, `PARSER_URL`/`TOKEN`/`BIND_ADDRESS`, office env, `parse_spool`, host network, port 8090. `docker-compose.ingest-host.nonprod.yml`: 11-28, 34-44, 104-158, 275, 299, 311-312. `docker-compose.yml:121-123,223-234`. `docker-compose.prod.yml:99`. `.env.example:112-123,181`. `.env.prod.example:127`. `.env.uat.example:126-130`. `ingest-host.env.example:24,35-48`. `ingest-host.nonprod.env.example:20-32`. `env-manifest.json` keys (`CAPY_MINERU_*`, `CAPY_PARSE_CONCURRENCY`, `CAPY_PARSE_SLICE_TIMEOUT`, `CAPY_PARSE_SLOTS`, `CAPY_PARSE_METHOD`, `PARSER_SLOT_TTL`, `PARSER_TIMEOUT`, `CAPY_INGEST_PARSER_MODELS_VOLUME`, `CAPY_INGEST_NONPROD_PARSER_*`, `CAPY_PARSER`); `pnpm test:deployment` validates. `scripts/deploy/ingest-host-remote-release.sh:108-109` comment and `parser_ready()` 100×15 s poll; service name `parser` throughout and in `test_ingest_release.py`. `deploy/ansible/ingest-host/README.md:45`; watchdog keeps watching `parser`. `.github/workflows/ci.yml:153` imports `parser/app.py` in the pipeline test process.

**Docs.** `openwiki/agentic-retrieval.md` rows 26, 29, 54, 222, 270, 282-284, section 288-388, 513, 1126, config table 1220. `openwiki/deployment-runbook.md:773, 880-890, 985-995, 1037-1070`. `openwiki/observability-metering.md:380, 667, 689-703`. `openwiki/frontend/office-files.md:166-168`. `openwiki/test-catalog.md:322,335,336,342,343,344`. `README.md:13`. `.todo:21`. `important-artifacts/office-editing/plan.md:143` (historical, annotate). `human/authorization-permissions-lifecycles.md:3` (caption wording stale).

**Tests.** `pipeline/tests/test_parser_app.py`: delete slice/pool cases (29, 84, 112, 176, 228, 263, 295); port 323, 354, 392, 420, 440, 460, 473-521. `test_parser_client.py`: `FAST_VERSION` 16, `cfg.parse_method="ocr"` identity test 85-90, quarantine 293-376, measurements 232-290 and 448-494. `test_ingest_worker.py`: 214, 1433-1465 (slot release), 1371-1424 and 1495-1539 (`CapacityWait`), `parser_version="marker-v1"` literals 899, 947, 995, 1037, 547-555, 1654. `test_store_sql.py:1534,1566,1578,1585`. `test_ingest_host_sampler.py:42-72`. `test_ingest_telemetry.py:72`. `test_figures.py:153-203`. `pipeline/tests/README.md:7`. No parser cassettes exist and no e2e fixture stubs the parser.

### A3. Contracts that must survive

- **Bundle** `capy-parser-bundle-v3`: entries `manifest.json`, `content_list.json`, `document.md`, `preview.pdf` (Office, must start `%PDF`), `images/*`; `manifest.json` keys `schema`, `parser_version`, `source_fingerprint`, `parse_receipt{id, request_id, measurements}` (`parser_client.py:161-186, 437-486, 516-541, 578-585`); `img_path` rewritten to `images/{basename}` (`app.py:671-676`).
- **content_list blocks** (`chunking.py:486-577`): `type`, `page_idx` (0-based), `bbox` (page-1000 top-left); `text` with `text_level`; `header`/`page_footnote`; `list` with `list_items`; `table` with `table_body` HTML, `table_caption`, `table_footnote`; `equation` with `text` or `latex`; `image`/`chart` with captions, footnotes, `description`, `img_path`; furniture `footer`, `page_number`, `aside_text`, `discarded` dropped; `_repeated_across_pages` 584-596 relies on `page_idx`.
- **Receipt keys** (`app.py:608-638` → `parser_client.py:73-99` → `worker.py:1274-1344` → `usage_events`, `ingest_job_attempts`): `_page_count`, `_ocr_page_count`, `_worker_cpu_ms`, `_server_parse_ms`, `_queue_ms`, `_execution_ms`, `_slice_count`, `_download_ms`, `_upload_ms`, `_worker_rss_bytes`, `_worker_pss_bytes`, `_worker_io_read_bytes`, `_worker_io_write_bytes`, `_parse_method`, `_source_format`, `_receipt_id`; billing uses `_page_count` and `_ocr_page_count` only; idempotency `parse-receipt:{fingerprint}:{job_id}`.
- **Request** `POST /file_parse` JSON: `source_key`, `source_sha256`, `output_key`, `filename`, `parse_method`, `artifact_schema`, `parser_version`, `source_fingerprint`, `request_id`, bearer `PARSER_TOKEN`; 400 on schema/version mismatch; errors `422 parse_hard_timeout|parse_oom`, `429 parser_capacity`, `503 parser_runtime_failed`; quarantine marker `quarantine/{fingerprint}.json` with `reason`, `source_fingerprint`, `parser_version`, `detail`.
- **Progress events** (`progress.py:40-65` → `sse_events.go` → `eventStream.ts`, `hooks.ts:1289-1307`): stages `queued` 5, `parsing` 15, `captioning|indexing` 45, `indexing` 55, `done` 100; no MinerU string reaches the browser.
- **Health** `GET /healthz`: Docker healthcheck, release script and watchdog use Docker health only; the sampler reads `active_jobs`, `queued_jobs`, `active_slices`, `queued_slices`, `oldest_active_slice_s`, `oldest_queued_slice_s`, `last_slice_completed_age_s`, `cgroup_oom_kill_events`, `cgroup_memory_bytes`, `pss_bytes`, `cgroup_memory_peak_bytes` (`host_sampler.py:193-225`).
- **Office preview**: `preview.pdf` → `worker.py:1709-1724` → B2 `previews/{source_sha256}/{parser_version}/{fingerprint}.pdf` → `files.preview_blob_path` → `FileViewer.tsx:51-104`; `processing_plan.office_preview` required for Office (`plan.py:34,224`, `rules.go:439`).

### A4. Hidden couplings and risks

1. `parser_version` in four identities (fingerprint `parser_client.py:141`, `pipeline_identity` `worker.py:1267-1271` with donor match `retrieval/store.py:354-410`, quarantine key `app.py:827`, preview key `worker.py:1037`).
2. `cfg.parse_method` in the fingerprint and identity string formats.
3. Timeout ladder validated at start (`config.py:286-293`), asserted by tests, lease 180 s (`jobs.py:72`), client timeout `parser_client.py:365`; the per-slice deadline is the only hard stop today.
4. Compose limits (prod 14g/18g/8 cpus, nonprod 6g/8g/2 cpus), `start_period: 15m`, cgroup v2 `memory.events` OOM watch (`app.py:173-186`); JVM heap must fit.
5. Four-everywhere: parser lanes, Redis slots, coordinator children, `parse_fast_slots` default, nonprod 1/1/1 plus flock.
6. Slice columns across seven places (see §8 above).
7. `mineru_parse` stage name persisted in `stage_timings`, shown by Ops.
8. Office normalisation lives only in `mineru_worker.normalize_document`.
9. Browser OCR estimator models MinerU's auto heuristic; `MAX_PDF_ANALYSIS_PAGES = 2000` is a browser bound.
10. `CAPY_PARSER=mineru` label stored, never read.
11. Block vocabulary is MinerU's; `CHUNKER_VERSION = "v5"` bumps if the adapter drifts.
12. `figures.py` is MinerU-shaped; goes with captioning.
13. Spool init creates dirs for uid 10001 mode 2770; sources are 0640.
14. Release and rollback scripts wait on Docker health of a service named `parser`.
15. Python 3.12 (parser) vs 3.11 (pipeline); `test_parser_app.py` imports `parser/app.py` in CI without Java or ONNX present.
16. UAT app host 2 vCPU / 3.8 GB; nonprod parser capped at 2 cpus / 6 GiB; JVM + RapidOCR + LibreOffice must fit.
17. Debian snapshot pin may lack the JDK package; moving it changes LibreOffice and therefore preview bytes.

### A5. Removal checklist (dependency order)

1. Freeze the A3 contracts as acceptance tests.
2. New parser module: `normalize_document` moved, `pdf_page_count`, `parse_document(data, name) -> {content_list, md, images, _ocr_pages}` in one process, a hard deadline raising `ParseHardTimeout`.
3. Rewrite `app.py` runtime around a depth-4 document queue; new `PARSER_IMPLEMENTATION`; new `_dependency_versions`; keep bundle, artifact, quarantine, health (slice keys as zeros).
4. New Dockerfile: OpenJDK 17, `opendataloader-pdf==2.5.7`, PyMuPDF, rapidocr, onnxruntime, models baked in, LibreOffice + fonts, uid 10001, port 8090. Delete `requirements.*` and the `/models` volume.
5. Bump `PARSER_IMPLEMENTATIONS[ROUTE_FAST]` and its test fixtures.
6. Remove `CAPY_PARSE_METHOD` everywhere it appears (A2) in the same release.
7. Retire slicing config; resize `PARSER_TIMEOUT`, `PARSER_SLOT_TTL`, `CAPY_PARSE_JOB_TIMEOUT` (900) in config, jobs, composes, env examples, manifest; rewrite or delete `test_parse_time_budgets.py`; run `pnpm test:deployment`.
8. Delete the Redis slot gate and its tests; rely on 429 → `CapacityWait`.
9. Rename `mineru_parse` → `parser_call`; update `test_store_sql.py`.
10. Health/sampler/Ops: keep zeros, relabel the Ops card.
11. Delete MinerU files; port `test_parser_app.py`; update `pipeline/tests/README.md` and the test catalog.
12. Compose, ansible README, release-script comment; drop `parser_models`; shrink `start_period`; retune limits for the JVM.
13. `CAPY_PARSER` label: change the default or drop env, column and argument; fix comments and `file_preview_test.go`.
14. Frontend copy and estimator; mocks; regenerate `src/api/gen` if the policy shape changes.
15. Docs listed in A2.
16. Verify on UAT: receipt pages, `parse_ocr_pages` = RapidOCR-routed pages, Office preview published, donor reuse on a second upload, quarantine on a forced timeout, Ops ingest-host page renders.
