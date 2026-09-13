# Review 2: fix round 1 of the refined ODL parser, capture_page, structured citations

Second, fresh read-only pass over the working tree on `main` after `fixes-1.md`
was applied. Scope: the 13 findings of `review-1.md` plus the slot default,
then a regression hunt on the fix round itself, the removal grep, the test
suites and the docs. Nothing was changed. The lab fixtures were compared
against the originals on the ingest host (`/opt/capy-odl-third-pass-20260909`)
so the "reproduces the lab" tests are known not to be tautologies.

## Summary

| Severity | Count |
| --- | ---: |
| blocker | 0 |
| major | 0 |
| minor | 3 |

All 13 fixes and the slot default are verified; none is re-opened. Every suite
the brief lists is green, `pnpm test:go` twice with no flake. The three minors
are new observations on the fix round, not regressions of something that
worked before: the streaming renderer and the batch parser disagree on one
malformed-passages shape so the decided repair call is skipped, `0009` can
leave the chat slot without a default on a database where GLM is disabled, and
the now-mandatory `refinement.json` has no negative validation test.

## Findings

### R2-1 (minor) A closed JSON answer with non-integer `passages` streams prose with no citations and skips the repair call

`pipeline/pipeline/retrieval/structured.py:378-381` (`StreamRenderer._add_passage`)
keeps only `token.isdigit()` entries and silently drops the rest, while
`parse_structured` (`structured.py:87-95`) rejects the whole object when a
passage entry is not an `int`. The agent takes the streamed path whenever the
renderer produced text (`agent.py:533`), so for
`{"answer":[{"text":"Carbon is fixed.","passages":["2"]}]}` (also `[2.0]`,
`[true]`) the browser gets `Carbon is fixed.` with an empty citation list and
`complete=True`, no warning, no repair call; the batch path for the same
string would have gone to `_repair_answer`. Verified with the module:
`parse: False | streamed: 'Carbon is fixed.' | order: []`. The decision
(`human/agentic-retrieval.md`, 2026-09-12) is one repair call when the answer
does not parse; the property test (`test_stream_renderer_random_chunking_property`)
only covers objects `parse_structured` accepts, so the two never had to agree
on rejected shapes. Scenario: GLM quotes the passage numbers once
(`"passages": ["1", "3"]`) — the answer lands without citations and the
`rag_search_events` row marks every hit uncited. Smallest fix: make the two
agree on the cheap side — accept digit strings in both (`parse_structured`:
`isinstance(n, int) or (isinstance(n, str) and n.isdigit())`, coerce;
`_add_passage`: `token.strip().strip('"')`) — and have `_add_passage` set a
renderer flag for any other token so the agent logs it like the unfinished
case. Add the three shapes to `test_structured.py` with the expected marks.

### R2-2 (minor) `0009` clears the chat slot default unconditionally and adds the new one conditionally

`server/migrations/0009_default_chat_model.sql:12-19`: the first `UPDATE`
removes `chat` from every non-GLM row; the second appends it only to an
`enabled` GLM row. On a database where the GLM row is disabled (an operator
can disable it through Ops because it was not a slot default before this
file) the migration commits with no chat default at all and
`model_registry_state.version` bumped. `Registry.DefaultPin("chat")`
(`server/internal/models/registry.go:436-444`) then returns `ErrNotFound`, and
`accountModelPrefs` (`server/internal/store/users.go:394-411`, called from
`UpsertUserFromClerk` at `:469`) fails every first sign-in until an operator
sets a default; Ops preference remaps hit the same error. UAT's seed row is
enabled, so this does not bite there; it is a fresh-database or
operator-state hazard. `TestForwardSeedMigrationsAreRerunnable` covers the
re-run, not this state. Smallest fix: make the file fail loudly instead of
half-applying — wrap the two updates in a `DO $$ ... $$` block that raises
when the append updates zero rows (`GET DIAGNOSTICS n = ROW_COUNT; IF n <> 1
THEN RAISE EXCEPTION ...`), or guard the clear with
`AND EXISTS (SELECT 1 FROM model_configs WHERE provider_slug='zai' AND
model_slug='glm-5.3-flash' AND enabled)`.

### R2-3 (minor) The mandatory `refinement.json` has no negative test at the bundle boundary

`pipeline/pipeline/parse/parser_client.py:458-460` now refuses a bundle
without `refinement.json`, and `:444` bounds it at 4 MiB (the parser writes it
under `MAX_ARTIFACT_ENTRY_BYTES`, 128 MiB, `parser/app.py:596-600`). The only
tests are the worker-level `test_page_chunks_refuse_a_bundle_without_the_frozen_furniture`
(after extraction) and the positive layout tests. The `_bundle` helper in
`pipeline/tests/test_parser_client.py:71-72` adds `refinement.json` to every
test bundle unless the caller passes one, so the rejection branch in
`_validated_entries`, the 4 MiB limit, and the restore-from-B2 fallback to a
local parse (`_restore_durable_artifact` → validation failure → warning →
parse) are unexercised. Scenario: a later edit to the required-entry set or
the limit goes unnoticed. Smallest fix: one test that builds a bundle with the
helper's `extra` omitting `refinement.json` (give the helper an
`omit: set[str]` parameter) and asserts `ParserClientError("... missing its
manifest, content list or refinement")` from `_validate_artifact_path`, plus
one asserting the durable-restore path returns `None` for it.

## Fixes verified

| Finding | Status | Where | Proof |
| --- | --- | --- | --- |
| F1 lab packer in production | verified | `pipeline/pipeline/retrieval/packing.py` (`pack_blocks`, `table_chunks`, `contextualize`), `parser/odl/furniture.py`, `parser/odl/refine.py:98-99` (furniture frozen before `recover_tables`), `parser/app.py:200,593-599,648` (`refinement.json` in every bundle), `chunking.py:46-50` v7, `worker.py:1725-1753` | `test_packing.py::test_packer_reproduces_the_lab_chunks_for_a_refined_bundle`: 200/200 chunks equal the lab `chunks.json`. Fixture `content_list.json` and `chunks.json` are byte-identical to the VM originals (sha256 `6d43218d…`, `ea180226…` confirmed over ssh), and the fixture `furniture` list equals the VM `refinement.json["furniture"]`; the test also proves the inferred set is two texts short and yields different chunks, so the frozen decision is load-bearing on this source. `test_parser_and_pipeline_copies_are_identical` pins the copied pieces. |
| F2 wrong-shape JSON → repair | verified | `agent.py:533-555` (streamed iff `renderer.json_shaped and renderer.text`; complete-but-empty render goes to `_repair_answer`) | `test_agent.py::test_complete_json_of_the_wrong_shape_is_repaired[3 shapes]` asserts a third call with `JSON_OBJECT`, one `block_delta` of the repaired prose, final list `["c2"]`; `test_structured.py::test_wrong_shape_objects_render_nothing_and_do_not_parse`. See R2-1 for the one shape the two parsers still disagree on. |
| F3 `0008` idempotent | verified | `0008_parse_page_rates.sql:10-19` deactivates `version = 1` only | `store/migrate_test.go::TestForwardSeedMigrationsAreRerunnable` re-applies the body after a full migrate and asserts exactly one active v2 row per key and no active caption rate — this is the review-1 state (a v2 row already active). |
| F4 test path | verified | `pipeline/tests/test_capture.py:225-228` resolves from `__file__` | `pnpm test:pipeline:offline` 607 passed from the repository root. |
| F5 timeout ladder | verified | `config.py:122,128,284-285` (2520 < 2700), `jobs.py:72`, both ingest-host composes, `docker-compose.yml:227-229`, `.env.example:119-120`, `ingest-host*.env.example`, `env-manifest.json`, runbook `:900-903`, wiki `:332-335`, `:1277` | `test_parser_client.py:410` asserts the request timeout is `cfg.parser_timeout`; `pnpm test:deployment` green; no `840`/`900`/`3600` left for these keys. Heartbeat is a thread (`worker.py:245-262`, every 30 s on a 180 s lease), independent of the 2520 s blocking call. |
| F6 font-repaired PDF for the post-passes | verified | `parser/odl/refine.py:118` (`parsed_pdf=repaired if repaired_fonts`), `parser/app.py:204-205,625-629,651-652`, `worker.py:1745-1752` (`parsed.pdf` > `preview.pdf` > source) | `test_confidence.py::test_font_repaired_pdf_scores_like_the_lab` (fixture page verified identical to the VM's four page-1 chunks; `<0.9` through the upload, `>=0.98` through the repaired bytes); `test_ingest_worker.py::test_page_chunks_apply_the_bundle_furniture_and_prefer_the_repaired_pdf` (preference order and the missing-source `RetryableError`); `test_parser_app.py::test_bundle_layout_carries_receipt_preview_and_rewritten_image_paths` / `::test_bundle_without_font_repair_carries_no_parsed_pdf`. |
| F7 no interim citations | verified | `agent.py:783-789` (`_run_tools` now only numbers passages and appends the tool messages); the only `events.citations` emitters are the answer stream (`:385`) and the final list (`:561`) | `test_json_answer_streams_as_prose_with_renumbered_citations` asserts the citations events are exactly the growing used list; `pnpm test` 298 passed. |
| F8 telemetry without base64 | verified | `capture.split_images` / `_image_bytes` (`image_url` data URLs and Anthropic `image` blocks), `models.measure_request_context:560,578-580`; every measurement site (`models.py:424,666,784,886`, `compact.request_context`) goes through it; `ContextComposition.total_tokens` is a property so the `replace` is counted | `test_captured_images_ride_into_the_next_request_only` asserts `with_image - without == 2` for a 56×28 JPEG. |
| F9 image tokens in the budgets | verified | `agent.py:276-309`: `capture.image_tokens(ctx.captures)` as `extra` to `pending.reserve` and to both `compact_messages` calls; `pending.reserve` uses `extra` only in the fit check, so `pending_reserve + image_tokens` is not a double count | `test_attached_captures_count_against_the_compaction_budget` asserts `extras == [0, 2240]`. |
| F10 cache key | verified | `capture.cache_name` = sha256 of `preview_blob_path or blob_path` (`capture.py:89-94,111`) | `test_capture.py` (catalog: "cache keyed by the stored object's path so a re-parsed Office preview is refetched"). |
| F11 Billing `caption` label | verified | `src/routes/Billing.tsx:34-36`; `billing_kind_caption` in `messages/en.json:253`, `zh.json:250` | `pnpm check` (ultracite + tsc) clean. |
| F12 docs | verified | wiki `agentic-retrieval.md:301,317-318`, runbook `:1053-1054,1089`, compose comment `ingest-host.yml:64`; `.todo:21` and `important-artifacts/office-editing/plan.md:143` annotated historical | read. |
| F13 decision reference | verified (orchestrator) | `human/observability-metering.md:27` now cites `0008_parse_page_rates.sql` | read. |
| Slot default | verified | `0009_default_chat_model.sql:12-20` clears `chat` from other rows, marks the newest enabled GLM row, bumps `model_registry_state`; trigger `protect_one_default_per_slot` passes in that order (no other row holds `generate/editor/quiz/ingest` or `captioning`); `users` column defaults and slot default both GLM | `TestForwardSeedMigrationsAreRerunnable` asserts exactly one chat default = `zai/glm-5.3-flash`; `models/registry_test.go` (`glmRef`), `ops/registry_test.go` (remap to GLM for chat, Flash elsewhere), `store/chat_pin_test.go` updated. See R2-2 for the disabled-GLM state. Note `accountModelPrefs` reads the registry slot default, not the `users` column default, so moving the slot default is what actually makes new accounts start on GLM. |

## Verified

### (a) `packing.py` against the bench originals

Function by function with `inspect.getsource` after stripping comments and
docstrings: `Cell`, `Table`, `table_units` identical to
`bench/parsers/scripts/structured_recovery.py`; `checked_spans` and
`native_spans` differ only by type annotations; `pack_units` differs only by
hoisting the heading regex into `_KEPT_HEADING` (same pattern); `CAPTION` /
`UNIT` equal `experiment_odl_native_tables.py`; `contextualize` is the bench
`contextualize(strict=False)` without receipts. `pack_blocks` equals
`stable_chunks` + `chunk_native_bounded` under `pack_odl`'s patches: the lab
contextualizes the furniture-free list and runs the loop with
`_repeated_across_pages` patched to `set()`; production filters the frozen
furniture first, contextualizes, and calls `chunk_content_list(...,
furniture=frozenset())`, which is the same thing (`chunking.py:516-517`).
`table_chunks` equals `chunk_structured([block])` for the table branch and
falls to `chunk_content_list([block])` for a native table the parser
relabelled (`mark_footer_tables` runs after `contextualize` in both the lab
and `refine.parse_pdf`), which drops it as a furniture type — as the lab did.
The lab's `odl_ocr` arm also merged the RapidOCR blocks before `pack_odl`
(`experiment_odl_selective_ocr.py:123-141`), matching `refine.parse_pdf:98-103`
(furniture frozen before `recover_tables`, OCR merged after). The bench
scripts still import from production chunking and still run: the new
`furniture` keyword defaults to the inferred set, so their `patch.object`
targets are intact.

### (b) `refinement.json` mandatory

Single producer: `_bundle_bytes` (`parser/app.py:550-655`) always writes it;
`run_document` puts `output.furniture` on every result (Office through
`normalize_document` → `parse_pdf`, PDFs with no text layer get `[]` and then
OCR lines). Failed parses (hard timeout, OOM, runtime failure, capacity) write
no bundle. Consumer side: `_validated_entries` requires it, `_entry_limit`
bounds it, `_page_chunks` re-checks it (`TerminalError`), contract tests pass
(the helper adds it; see R2-3). A B2 bundle from before the file existed fails
`_restore_durable_artifact` validation and falls back to a local parse with a
warning; a stale local spool entry is caught by `publish_durable_artifact` →
`discard_artifact` and by the one-time artifact repair path
(`worker.py:2362-2386`). No `PARSER_IMPLEMENTATION` bump is needed for cache
invalidation: `parser_version()` is `{implementation}+{RELEASE_SHA}`
(`parser_client.py:103-108`, `app.py:54`) and that string is in the artifact
fingerprint, the durable key, the quarantine marker and `pipeline_identity`
(`worker.py:1262-1266`), so no deployed release can reuse another's bundles
or donors; the only exposure is a developer spool or bucket with
`RELEASE_SHA=dev`, which self-heals at the cost of one attempt. Donor reuse
across the round-1 chunk shape is also cut by `CHUNKER_VERSION` v7.

### (c) `parsed.pdf`

Bounded on both sides: parser `parsed_size > MAX_ARTIFACT_ENTRY_BYTES`
(128 MiB, above `MAX_SOURCE_BYTES` 100 MiB) and the expanded-size sum
(`app.py:625-641`); pipeline `_entry_limit` falls to
`parse_artifact_max_entry_bytes` (128 MiB) and `_read_entry` streams against
it. Only written when `repaired_fonts > 0`; `repair_fonts` returns the upload
byte-for-byte otherwise (`fonts.py:98-113`). Excluded from the Office preview
path: `_cache_office_preview` reads `raw_dir / "preview.pdf"` only
(`worker.py:1073`) and the worker's preview publication uses the same path
(`:1698`); `_page_chunks` is the only reader of `parsed.pdf`. For an Office
source that trips the font gate the repaired LibreOffice PDF is the page model
and the unrepaired preview is still what the browser and `capture_page`
render, which is consistent (rendering does not use `ToUnicode`).

### (d) Timeout ladder

`PARSER_TIMEOUT` 2520 / `CAPY_PARSE_JOB_TIMEOUT` 2700 / `CAPY_PARSE_DOCUMENT_TIMEOUT`
600 agree in `config.py`, `jobs.py`, `docker-compose.ingest-host.yml`,
`docker-compose.ingest-host.nonprod.yml`, `docker-compose.yml`,
`.env.example`, `ingest-host.env.example`, `ingest-host.nonprod.env.example`,
`env-manifest.json`, `deployment-runbook.md`, `agentic-retrieval.md`; the
validator `config.py:284-285` holds. The lease is renewed by a thread every
30 s (`worker.py:252`) while the 2520 s `requests.post` blocks in
`asyncio.to_thread`, so a full-queue wait is covered; the `requests` timeout is
a per-read bound and the parser answers once, so it is the wall bound in
practice. Nothing on the Go side times a parse job (`ingestReservationHold`
is effectively unbounded).

### (e) `0009`

Run against the trigger in order: `array_remove` on Flash leaves
`{generate,editor,quiz,ingest}` (no clash), `array_append` on GLM v1 gives
`{captioning,chat}` (no other row holds either), `model_registry_state`
bumped in the same file (one transaction in the migrator). `users` column
defaults and slot default agree; the Go tests pin GLM as the chat default and
Flash for the other slots. Re-run is a no-op (`TestForwardSeedMigrationsAreRerunnable`).
Disabled-GLM state: R2-2.

### (f) `agent.py`

Terminal tools-off call: `tools_off = terminal_call or step == planning_cap - 1`
(`agent.py:265`) and `response_format=JSON_OBJECT if tools_off` (`:348`);
`calls = []` is forced for the terminal call. Malformed mid-stream answer:
`json_shaped and text` with `complete=False` keeps the streamed prose and logs
(review-1's accepted reading); `json_shaped` with empty text (cut before any
claim text, or a closed wrong-shape object) goes to `_repair_answer`, which
runs tools-off with `JSON_OBJECT` and the `REPAIR_PROMPT` after the raw
assistant text; a failed repair returns the raw text with `[]`. On a
credits-exhausted terminal answer the repair call is refused at admission and
falls into that branch, so a wrong-shape terminal answer is shown as its raw
JSON — the decided fallback, noted here only because review-1 said "empty
reply" and the new behaviour is "raw text". `renderer.order` holds the
original passage numbers (`Renumberer.number`), so `_ordered_citations` and
`_record_searches` index `ctx.citations[n-1]` correctly and `cited` flags are
right after renumbering; `cited_order` from the repair path is
`render_structured`'s order, same semantics. Citations events precede the
delta carrying a new marker in the streamed path; the `finish()` tail is the
one delta that can carry a marker before its list (final list follows before
`done`), cosmetic. Lenient-vs-strict disagreement on rejected shapes: R2-1.

### (g) `measure_request_context` with images

`provider_messages` keeps list content; `split_images` removes `image_url`
data-URL parts and Anthropic `image` blocks, counts `patch_tokens` from the
JPEG header (PIL, lazy), and a non-image part is kept and measured as text.
Both the chat-completions and Anthropic shapes are produced by
`capture.image_part`; the Responses route converts list content to
`input_image` in the real call and in measurement (`_responses_content`).
All four measurement sites and `compact.request_context` go through the one
function.

### Removal grep (outside `bench/`, `artifacts/`)

`mineru`/`MinerU`: `.todo:21` and `office-editing/plan.md:143` (annotated
historical), `test_ingest_plan.py:63` and `0008:1` comments, wiki history at
`agentic-retrieval.md:711`, `human/agentic-retrieval.md:43` (the decision),
test-catalog rows for bench scripts. `parse_method`: only the `_parse_method`
receipt key (A3). `CAPY_PARSE_METHOD`, `CAPY_PARSE_SLOTS`, `slice_pages`,
`CaptionImages`, `SupportsFigures`, `DEEPINFRA_GLM`: none. `caption_images`:
`0001` (frozen), `0007`, two doc lines. `zai-org/GLM`: one wiki history note.
New TypeScript: no `any`, no template-string or variable `className`, the one
new user-visible string goes through `m.chat_tool_capture_page`
(`ChatPanel.tsx:266`); Ops copy is operator-facing English like the rest of
`ops/`. `src/api/types.ts` re-exports `ActivityCapture` rather than importing
the generated model elsewhere.

### Docs

`openwiki/test-catalog.md` lists every added file (`test_capture.py`,
`test_confidence.py`, `test_odl_refine.py`, `test_packing.py`,
`test_structured.py`, both fixtures) and no removed one (`test_figures.py`,
`test_mineru_worker.py`, `test_parse_slots.py`, `test_parse_time_budgets.py`
absent); `test_ingest_worker.py`, `test_parser_app.py`, `test_parser_client.py`,
`migrate_test.go`, `registry_test.go`, `chat_pin_test.go` rows describe the
new cases. `agentic-retrieval.md` describes the packer (`:637-650`), the
bundle entries (`:362-365`), the post-pass PDF choice (`:654-657`), the
timeouts (`:316-335`, `:1277`), the image patch estimate (`:1059-1060`);
`observability-metering.md:996-998` the capture telemetry;
`deployment-runbook.md:267-270` the `0009` slot default, `:900-903` the
ladder, `:1053-1054,1089` the queue and deadline start.

## Test runs

| Command | Result |
| --- | --- |
| `pnpm test:pipeline:offline` | 607 passed, 120 deselected, 5 warnings in 7.04s |
| `pnpm test:pipeline:replay` | 4 passed in 0.30s |
| `pnpm test:go` (run 1) | 20 packages `ok`, exit 0 |
| `pnpm test:go` (run 2) | 20 packages `ok`, exit 0 — the Stripe reconcile test did not flake in either run |
| `pnpm test` | `src`: 63 files / 298 tests passed; `bench/editor`: 1 file / 4 tests passed |
| `pnpm test:deployment` | unittest 11 + 13 + 2 OK; node `--test` 3 pass / 0 fail |
| `pnpm check` | ultracite: "Checked 621 files in 957ms. No fixes applied."; `tsc -b --noEmit` clean |
| `go vet ./...` (in `server/`) | clean |
| Extra: `pytest test_packing.py test_confidence.py test_structured.py test_agent.py::test_complete_json_of_the_wrong_shape_is_repaired` | 33 passed |

## Operational notes (not defects)

- `model_capacities` still needs a `tencent:glm-5.3-flash` row and
  `TENCENT_API_KEY` on the retrieval/ops resources before the first new
  sign-up on UAT, as review-1 noted; `0009` makes GLM the account default.
- Every deploy re-parses every source because `RELEASE_SHA` is part of the
  artifact and donor identities; this predates the change and is why leaving
  `PARSER_IMPLEMENTATION` at `…-v1` is safe.
