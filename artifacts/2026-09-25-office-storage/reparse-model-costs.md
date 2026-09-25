# Office source files: paid model calls, what a reparse redoes, and the forced-publication plan

2026-09-25. Code traced at HEAD `3758a0e2` plus the working tree. Measurements ran locally with
the production parser image built from `ab1a39fd` (parser v11, `capy-kb-parser:pilot-v11`, run as
a scratch container and then removed) and the pinned BetterOffice headless runtime
(`vendor/betteroffice` at `dfa3f05e`, `shared/office-checkpoint.mjs`), which is what the
collaboration service runs. No paid API was called. Credit figures apply the seeded rates to the
measured page and token counts. Token counts are the pipeline's own `estimate_tokens`, not
provider tokenizer counts.

## Short answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Which paid external model calls does an Office file cause? | Two, both in the ingest stage: embeddings (DeepInfra Qwen3-Embedding-4B) and one file-summary completion (ingest slot, seeded as DeepSeek Flash, thinking off). Parsing, OCR and layout run locally on the ingest host, but users pay 1.0 credit per page for them. No image captioning, no transcription. | `pipeline/pipeline/retrieval/indexing.py:113-128,166-174`; `parser/odl/ocr.py:40-61`; `parser/odl/layout.py:21-29`; `server/migrations/0008_parse_page_rates.sql:14-19`; `pipeline/pipeline/ingest/plan.py:191-194` |
| Are model calls made only during reparsing? | Yes for everything billed to the file: the initial ingest and each refresh (the "reparse"). Editing, saving, viewing, checkpoints and applying agent edits make no model call. Two chat-time costs sit outside this: every chat or generate request carries the exact pending edits as input tokens, and `resolve_source_change` is meant to caption an edited image with the vision model. That caption call currently fails before reaching the provider (below). | `collaboration/src` has no provider calls (its only `fetch`es go to the Go API and B2); `server/internal/store/source_documents.go:244-331`; `pipeline/pipeline/retrieval/agent.py:404-452`; `pipeline/pipeline/retrieval/models.py:875` |
| Does a reparse redo the whole file? | Yes. The whole current state is exported to a new file, the whole file is converted and parsed, and every page is billed. Everything is re-chunked. | `collaboration/src/sourceDocuments.ts:777-845`; `server/internal/store/source_refresh.go:196-203`; `pipeline/pipeline/ingest/worker.py:1121-1190,2228-2262` |
| Re-embed everything? | No. A chunk reuses its vector only when its `indexed_text` exactly matches a chunk of the currently published version, in the same embedding pin. Measured reuse for a 439-page book with chapter page breaks: 98% (one-sentence edit), 91% (12 paragraphs rewritten), 96% (20 scattered one-word fixes). Inside one long section with no page breaks, reuse drops to 39–72%. On the first refresh after upload it was 31% even with no edit, because the BetterOffice exporter drops manual page breaks. | `pipeline/pipeline/retrieval/store.py:118-149`; measurements below |
| Re-caption only changed images? | Office ingest never captions images. Image blocks are indexed by their parser caption and footnote text only. | `pipeline/pipeline/ingest/plan.py:191-194`; `worker.py:1521-1557`; `openwiki/agentic-retrieval.md:852-858` |
| Summary from scratch, or the previous summary plus the delta? | From scratch, over the full text. Both tiers (a ~50-word descriptor and a 150/300/500-word summary) come from one call that reads every chunk. The 439-page book is a single ~325k-token request. Map-reduce only starts above ~991k estimated tokens, roughly 1,350 pages at the same density. The previous summary is never read. This matches the recorded decision. | `indexing.py:166-174,372-383,455-486`; `pipeline/pipeline/registry.py:477-478`; `human/agentic-retrieval.md:33` |
| Who pays? | The workspace owner pays for both automatic and manual refreshes, because manual processing is owner-only. The existing code has no system or platform payer, so a forced publication would also bill the owner. | `source_documents.go:407-411,435-441`; `human/observability-metering.md:12` |
| Out of credits, over quota, suspended? | The refresh is refused at admission and no job is created. The file gets `refresh_error`, which pauses automatic refresh until the next save clears it. Authored edits are never discarded; they stay unpublished. An over-quota or suspended owner cannot even save new edits. | `server/internal/store/credits.go:856`; `server/internal/store/account_state.go:101-125`; `collaboration/src/sourceDocuments.ts:861-879`; `source_documents.go:314,413-415` |
| Library "book summaries"? | They are not model-written. A book version's descriptor is its manifest attribution line. Its summary is its top-level section titles joined with " · ". A book update publishes a new version with all content rows rewritten. The builder caches embeddings per exact text, so only changed chunk texts are re-embedded. | `bench/rag/scripts/knowledge_base_library.py:448-453,704-708`; `bench/rag/scripts/knowledge_base_pilot.py:815-860`; `human/agentic-retrieval.md:139` |

Cost per refresh is dominated by parse pages: 82–96% of credits. The summary is 15–17% for
text-heavy documents and 4–11% for decks and sheets. Embeddings are at most 2%. For a 439-page
book, one refresh costs about 521 credits, roughly half of a Free user's monthly 1,000. The
automatic trigger does not scale with document size: 5,000 estimated net tokens after 60 seconds
idle. About 25–30 edited paragraphs therefore trigger a full-price refresh of a 439-page book.

## Measurements

Inputs, all under the scratch folder `probe/`:
- A 439–442-page DOCX. LibreOffice built it from the OpenIntro Statistics text in the knowledge
  base pilot run: 177k words, 9 chapters, a page break before each chapter.
- One 40-page chapter of the same text, with no page breaks.
- A 33-slide Chinese lecture deck (`zh_TW_llm.pptx`, 8.7 MB, 4 slides routed to OCR).
- The BetterOffice `showcase.xlsx` workbook.

Edits were applied with the headless `applyOfficeCommands` and exported with `exportOffice`,
which are the collaboration service's calls. Each variant was parsed by the real parser. Chunks
were built with the ingest worker's Office path (`pack_blocks`, `retain_headings`,
`score_chunks`, as in `worker.py:1562-1587`). Reuse is the fraction of candidate chunks whose
`indexed_text` exists in the base, which is exactly what `existing_file_vectors` matches.

| Refresh (base → candidate) | Net tokens (auto trigger) | Pages | Chunks | Vector reuse | Tokens embedded | Summary input tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Book upload → export, no edit (first refresh) | 0 | 442 → 439 | 1,002 | 31.4% | 226,889 | 321,923 |
| Book export → one-sentence edit | 179 | 439 | 1,003 | 98.2% | 5,771 | 322,194 |
| Book export → 12 paragraphs extended | 5,485 | 439 → 442 | 1,020 | 90.9% | 29,909 | 327,025 |
| Book export → 20 one-word fixes | 3,710 | 439 | 1,001 | 95.9% | 13,451 | 321,556 |
| Chapter export → one-sentence edit | 379 | 40 | 90 | 97.8% | 829 | 29,337 |
| Chapter export → 12 paragraphs extended | 6,253 | 40 → 43 | 100 | 39.0% | 20,091 | 33,095 |
| Chapter export → 20 one-word fixes | 4,655 | 40 | 90 | 72.2% | 9,184 | 29,338 |
| Deck upload → one text edit | 13 | 33 | 41 | 95.1% | 105 | 3,078 |
| Deck upload → 10 edits on 10 slides | 180 | 33 | 39 | 71.8% | 1,388 | 3,131 |
| Workbook upload → one cell | 25 | 16 | 19 | 94.7% | 59 | 5,068 |

Unedited exports of the chapter, the deck and the workbook produced the same content hash as
the upload. A refresh that lands on identical content attaches the ready content row and skips
embeddings and the summary (`worker.py:2341-2375`). It still pays for the parse.

Credits per refresh at the seeded rates. Parse costs 1.0 credit per page, digital or OCR
(`0008_parse_page_rates.sql:14-19`). Embeddings cost 50 µcredits per token
(`0001_init.sql:2102-2107`). The summary costs 250 per input token and 1,000 per output token,
uncached, with about 750 output tokens (`0001_init.sql:2067-2073`, copied to `deepseek-flash` by
`0010_deepseek_flash.sql:32-38`).

| Case | Parse | Embed | Summary | Total | Parse share |
| --- | --- | --- | --- | --- | --- |
| Book, initial ingest | 442 | 16.2 | 82.0 | 540 | 82% |
| Book, first refresh (no edit) | 439 | 11.3 | 81.2 | 532 | 83% |
| Book, one-sentence edit | 439 | 0.3 | 81.3 | 521 | 84% |
| Book, 12-paragraph edit | 442 | 1.5 | 82.5 | 526 | 84% |
| Chapter, 12-paragraph edit | 43 | 1.0 | 9.0 | 53 | 81% |
| Deck, 10 edits | 33 | 0.1 | 1.5 | 35 | 95% |
| Workbook, one cell | 16 | 0.0 | 2.0 | 18 | 89% |

The 25 KB workbook renders as 16 LibreOffice print pages, so it is billed 16 credits per refresh.

Wall time on this 16-core desktop, with the parser single-threaded except OCR:

| Step | Book | Chapter | Deck | Workbook |
| --- | --- | --- | --- | --- |
| Parse, including LibreOffice | 31–35 s | 5–8 s | 16–17 s | 3 s |
| Collaboration export + seed + baseline | 3.0 + 2.9 + 3.7 s | 1.1 s total | 1.1 s total | 0.8 s total |

A parser bench on a 4-CPU, 1.9 GiB container took 167 s for a 610-page, image-heavy PDF
(`bench/parsers/reports/2026-09-13-odl-implementation.md:140`). The summary call's latency on a
~325k-token prompt was not measured, because that would be a paid call.

Transient storage a refresh charges to the owner, measured:

| File | Captured state | Seed | Baseline | Transient total |
| --- | --- | --- | --- | --- |
| Book (417 KB DOCX) | 12.9 MB | 14.1 MB | 3.5 MB | ~31 MB |
| Deck (8.7 MB PPTX) | 9.6 MB | 9.6 MB | — | ~28 MB |

These are the gates at `source_documents.go:451` and `source_refresh.go:180-185`. The candidate
row's `storage_bytes` is defined at `0001_init.sql:1543` and redefined by migration 0015.

## Details

### 1. Initial ingest of a DOCX, XLSX or PPTX

- **Parser.** No external calls. LibreOffice converts the whole file to PDF (180 s timeout; a
  PDF over 128 MiB is refused) in `parser/odl/document.py:28-81`. OpenDataLoader then parses
  every page (`parser/app.py:184-226`, 600 s deadline at `:96-98`). Pages with under 40
  characters go to local RapidOCR ONNX with CUDA off (`ocr.py:20-37,40-61,115-129`), then to the
  local PP-DocLayoutV3 for ordering (`layout.py:21-29`). `parser/requirements.in` lists no
  provider SDK. Billing is one usage row per page at the digital or OCR rate, recorded at
  handoff against the job's actor (`worker.py:1121-1190,1257-1272`).
- **Parse coordinator.** No model calls. It downloads the source and hashes it, then looks for a
  donor. A ready content row with the same `(source_sha256, pipeline_identity)` is copied with
  its vectors and summary: no parse, no calls, no parse charge (`worker.py:2184-2226`,
  `store.py:445-503`). The coordinator takes that fast path only when the donor is in the same
  embedding space (`worker.py:2197-2208`). Otherwise it parses and enqueues the continuation
  (`worker.py:2228-2262`).
- **Ingest worker, Office route.** It extracts the bundle and chunks the whole content list
  (`worker.py:1521-1557,1562-1594`). Chunks target about 400 estimated tokens with a 50-token
  overlap (`config.py:161-162`), and `indexed_text` is the breadcrumb plus the body
  (`chunking.py:149-152`).
  - No captioning, and no transcription (the audio route only, `worker.py:1484-1495`).
  - **Embeddings:** every chunk's `indexed_text` not already present, in batches of 64
    (`models.py:318-375`, `config.py:167`).
  - **Summary:** all chunk texts joined into one body. It is one call when the body fits
    `input_budget = window − 8192` minus prompt overhead (`indexing.py:372-383,455-486`,
    `registry.py:477-478`). With the 1M-token DeepSeek Flash pin this is 991,125 estimated
    tokens (computed with the real helper), so the 325k-token book is one call. Larger bodies
    are map-reduced over chunk groups with full coverage (`indexing.py:414-452`). The word
    target is 150, 300 or 500 by size (`indexing.py:302-307`). Thinking is disabled on
    DeepSeek (`elitellm/client.py:205-209,875-880`), there is no `max_tokens`, and the per-call
    timeout is 120 s (`config.py:92-93`).
  - A summary failure raises and retries the job rather than storing a blank
    (`indexing.py:476-482`).

### 2. Editing and saving

- The collaboration service's only network calls go to the Go API, B2 presigned URLs and
  projection (`projection.ts:33`, `sourceDocuments.ts:185,255,811`). None goes to a model
  provider.
- Each save runs `officeBaseline` and `compareBaselines` on the service's single Office worker
  (`sourceDocuments.ts:380-431,534-556`, `officeRuntime.ts:119-176`). This is CPU work only.
- Go checkpoints, access checks and sessions are database-only
  (`source_documents.go:149-331`).
- **Agent edits.** `inspect_document` and `edit_document` go through Go into
  `SourceDocumentStore.applyEdit`, which calls `applyOfficeCommands` and then the checkpoint
  (`sourceDocuments.ts:623-740`). The only model cost is the chat turn itself, billed to the
  chat actor. Inspection pages 60 entries at a time (`tools.py:1794-1819`).
- **Viewing** unpublished edits exports in a disposable browser worker. There is no server call.

### 3. What a refresh actually does

1. **Admission.** `RequestSourceRefresh` is owner-only (`source_documents.go:407-411`).
   Automatic admission needs no `refresh_error`, pending net tokens, and for Office a prior
   successful parse, 5,000 net tokens (or `desired_manual`) and 60 s idle
   (`source_documents.go:412-426`; the scheduler query at `sourceDocuments.ts:853-860`). It
   reserves ingest credits on the payer (`:435-441`) and gates owner storage for a copy of the
   current state (`:451`).
2. **Export.** The collaboration scheduler runs every 5 s (`collaboration/src/server.ts:1616-1627`).
   Each tick admits up to 8 files and exports up to 2 candidates, one after the other
   (`sourceDocuments.ts:847-896`). The export is `exportOffice` of the full state, then
   `seedOffice` of the exported bytes and a baseline, then a B2 PUT (`:777-845`). Finalizing
   turns the job into a `parse` job over the new file (`source_refresh.go:196-203`).
   - Exports are deterministic: measured, the same bytes for different job seeds on all three
     test files. A retry with no new edits therefore reuses the fingerprint-addressed parse
     artifact while it is cached, and is not billed again (`parser/app.py:956-983`,
     `parser_client.py:138-144`).
3. **Parse.** The whole file, with every page billed. A donor hit is practically impossible,
   since new bytes mean a new SHA.
4. **Index.**
   - The candidate is attached to `source_refresh_candidates`, not to the file alias
     (`store.py:386-396`), so the published alias still points at the old content.
     `existing_file_vectors` reads that published content and reuses vectors for identical
     `indexed_text` in the same pin (`store.py:118-149`, `indexing.py:119-128`), with a test at
     `pipeline/tests/test_indexing.py:208-240`.
   - If the new content hash already exists as a ready row, there are no model calls
     (`worker.py:2341-2375`).
   - Otherwise `summarize_file` runs over all chunks (`indexing.py:166-174`).
5. **Publish.** `_finish_source_refresh` posts to the gateway, which proxies to the collaboration
   handoff (`worker.py:339-414`, `internal_sources.go:11-40`). The handoff asks connected editors
   to flush (10 s), waits for instance acknowledgements (15 s), and rebases newer saves with up
   to 4 retries (`sourceHandoff.ts:186-194,320-372`). `PublishSourceRefresh` then swaps the
   alias, the file blob, the state and the epoch, and gates storage growth
   (`source_refresh.go:213-347`).

**Why reuse collapses.** ODL splits paragraphs at page boundaries, so reflow after an edit changes
chunk text on every later page until a hard page break. Packing inside the edited section also
shifts. The worst case is the first refresh of a DOCX with manual page breaks:

- `exportOffice` turns `<w:br w:type="page"/>` into an empty run.
- Minimal repro: a 2-page DOCX exports as 1 page (`probe/pb.docx`, `probe/pb-export.docx`).
- The book went from 442 to 439 pages and 31% reuse. The same book built without page breaks
  exported to identical chunks: 100% reuse, same content hash.
- This is upstream fix `0f1ab4a7`, already on the port list at
  `artifacts/2026-09-24-betteroffice-upstream-handoff.md:438-442`. It is not in pin `dfa3f05e`.

**Captions at publication.** No caller passes a `source_refresh_job_id` to `caption_cache`, so the
candidate never consumes captions. Publication therefore unpublishes all of the file's caption
associations and deletes those that the remaining pending effects do not reference
(`source_refresh.go:310-317`).

### 4. Who pays, and what happens when the owner is blocked

- **Automatic refresh:** the payer is the owner (`source_documents.go:435-438`). The job's
  `actorUserId` is the payer (`:456`, `server/internal/store/jobs.go:181-206`), so parse pages,
  embeddings and the summary all bill the owner. Storage is always the owner's.
- **Manual refresh:** the payer is the actor, and the actor must be the owner. Editors see a
  label only (`human/agentic-retrieval.md:27`).
- **System-forced publication:** no code path exists. The internal endpoint takes `actorId` and
  `automatic` from the collaboration secret (`huma_source_documents.go:180-189`), and the store
  rejects any non-owner actor. Using the owner's id means the owner pays.
- **Out of credits:** `exhaustedIfOverLimit` refuses (`credits.go:856`, HTTP 403 at
  `huma_register.go:247-262`). The scheduler stores `refresh_error` for any non-409 answer
  (`sourceDocuments.ts:867-878`). Automatic refresh stays off until a save clears the error
  (`source_documents.go:314`). A month rollover alone does not retry.
  - A job admitted before exhaustion runs to completion (`worker.py:760-797`,
    `human/observability-metering.md:15`).
  - The owner's 21st concurrent ingest session is refused as `too_many_ingest_leases`
    (`credits.go:51-52,868-870`, HTTP 429), which the scheduler handles the same way.
- **Over quota (grace or frozen), suspended, deletion pending:** `sourceLockTx(edit=true)`
  accepts only an Active owner (`account_state.go:101-125`, `source_documents.go:137-145`). That
  blocks admission, export claim, finalize, publish and new saves.
  - An in-flight job fails at the next stage check: owner storage and lifecycle at
    `db.py:2316-2387`, account and ACL locks at `store.py:261-278`. Its candidate is discarded
    with `refresh_error` (`db.py:122-147`).
  - A healthy owner near the limit can also fail the transient storage gates (about 31 MB for
    the book).
- **In every case** the authored state and `pending_effects` stay in `source_documents`.
  Viewers still render the saved state (`human/frontend/office-files.md:6-7`). Chat keeps
  receiving the pending delta at the chat user's expense.

### 5. The forced-publication maintenance flow

**Cost per file.** The same as a manual refresh: all pages of the exported file, embeddings for
changed chunks, and a full summary. That is about 521 credits for the 439-page book, 50 for a
40-page document, 35 for a 33-slide deck and 18 for a 16-page workbook. Each is billed to the
owner under the current code. A retry with unchanged state is not billed for the parse again,
but it pays again for embeddings and the summary, because the candidate content is deleted on
failure (`worker.py:2394-2396`, `db.py:144-147`).

**Throughput.** Production has one parser process running one document at a time, behind a
FIFO of depth 4 and 4 coordinators (`parser/app.py:90-92`, `openwiki/agentic-retrieval.md:569-585`).
It shares the 8-core host with the nonprod parser. Drain time is therefore about the sum of the
parse times: roughly 3–35 s per file for the measured types, and minutes for image-heavy books.

- 100 ordinary course files take roughly 10–30 minutes. 100 book-sized files take roughly 1–5
  hours.
- Four ingest workers run embeddings and summaries in parallel. Model capacity is not the limit:
  300 DeepSeek and 120 embedding ingest slots (`deploy/model-capacities.sql:25-27`).
- Exports are capped at 2 per scheduler tick. They run on the one Office worker thread that also
  serves live saves, and a book export occupies it for about 10 s.
- During the drain, chat `capture_page` on Office files goes through the same parser queue and
  will get 429s (`retrieval/capture.py:151-200`, `parser/app.py:1114-1121`).

**Failures that leave edits unpublished:**
- **Admission** (no job is created):
  - out of credits
  - 20-session cap
  - owner not Active
  - storage gate on the state copy
  - a refresh already running (the request is coalesced into `desired_checkpoint`)
  - for the automatic path only: a stale `refresh_error`, less than 60 s idle, or under the
    threshold without `desired_manual`
- **Export:**
  - engine error or export over 100 MiB (`sourceDocuments.ts:809-810`)
  - B2 PUT failure (`:817-818`)
  - two claims without finishing (`source_refresh.go:106-121`)
  - export larger than 30 MiB, the maximum over plans (`:170-176`)
  - storage growth gate (`:180-185`)
  - owner lock at claim, which cancels the job (`:85-96`)
- **Parse:**
  - LibreOffice timeout or oversize output
  - the 600 s deadline or OOM, which quarantine the fingerprint and are terminal
  - two attempts at most (`jobs.py:65-81`)
- **Ingest:**
  - provider errors after 2 attempts
  - a provider still busy after 5 waits
  - the summary call exceeding the 120 s call timeout or the provider's real context limit
    (unverified)
  - owner lifecycle or storage changes mid-job
- **Publication:**
  - an editor who does not flush within 10 s, or disconnects
  - saves still advancing after 4 rebases, or storage growth refused. This is a 503 or 403,
    then one publication-only retry, then terminal (`worker.py:400-412,2654-2741`).
  - a 409, which discards the candidate as stale and re-admits it later at full cost
    (`worker.py:626-654`)

**Two points the plan needs.** The review at
`artifacts/2026-09-25-betteroffice-handoff-review.md:136-152` makes the same observations.
- A successful publication still stores an old-engine state: the seed of the export, or the
  rebased state (`sourceDocuments.ts:462-473,807`; `source_refresh.go:321`). Every room still
  needs an epoch bump and a reseed after the deploy.
- Publishing on the old engine makes its export losses permanent in the published file: page
  breaks as measured here, and the opaque drawings from `4bf205b5`.

### 6. The knowledge library

- No model-written book summary exists, and nothing in retrieval reads one. The summary stage
  was dropped on 2026-09-19.
- Excerpt synopses, roles and topics come from the builder's review and tag stages, on the
  developer PC with the developer's provider accounts. They are not billed to users.
- A republish writes a new version: a new content id, with all chunks and vectors written and the
  pointer swapped (`knowledge_base_library.py:484-503,693-715`).
- The builder's `embed_cached` keys vectors by `(pin, text)` in the run directory, so repairs
  re-embed only changed chunk texts (`knowledge_base_pilot.py:815-860`).

## Options with measured trade-offs

1. **Reuse the previous summary when little changed. This is the smallest change.**
   - **Change.** In `index_file`, `index_file` already knows the tokens of chunks it had to
     embed (`missing`). When their share of all chunk tokens is below a threshold, read the
     published content's `rag_content_summaries` row, reached through the same alias as
     `existing_file_vectors`, and write it for the new content instead of calling
     `summarize_file`. This is about 20 lines in `indexing.py` plus a store read.
   - **Saving.** About 81 credits per book refresh and 8–9 per 40-page document, which is
     15–17% of credits and all of the refresh's provider LLM spend. For decks and workbooks it
     is 1.5–2 credits (4–11%). The measured steady-state changed shares were 1.8%, 4.1% and
     9.1% of book chunks.
   - **Cost.** The descriptor and summary lag small edits. They only feed `list_sources` and
     `describe_documents` and are never cited, and chunks and pending deltas stay exact.
   - **Needs sign-off:** the threshold, and whether to force a full regeneration every Nth
     refresh.
   - **Variant: delta update.** Send the old summary plus the new and removed chunk texts:
     6k–30k tokens, 1.5–7.5 credits in the book cases. It needs a new prompt, a
     `SUMMARY_VERSION` bump and a quality check, so it is more work for a smaller extra benefit.
2. **Embeddings are already incremental.**
   - Porting the page-break export fix (`0f1ab4a7`) takes the book's first refresh from 31% to
     about 100% reuse. That saves 11 credits and ~227k embedding tokens, and above all it
     preserves the user's layout and citation pages.
   - Matching on whitespace-collapsed text would add 0.3–18 points of reuse, worth at most 3
     credits per book. It reuses vectors computed for different strings. Not recommended.
3. **The parse fee is the real cost and cannot be made incremental.** LibreOffice layout is
   global. The levers are policy:
   - price a refresh parse by changed pages or at a flat rate
   - make the automatic threshold relative to document size, for example a percentage of the
     document's tokens, instead of a flat 5,000
   The parse runs on the fixed-cost host, so this is a pricing decision rather than a provider
   bill.

## Recommendation

- **For the developer's question.** Model calls are limited to ingest and refresh, but a refresh
  re-reads the whole book for the summary and re-parses every page. If refresh cost matters,
  first decide on parse pricing or the size-relative threshold, which covers about 83% of the
  credits. Then take option 1 for the summary. Leave the embedding path alone apart from the
  exporter fix.
- **For the maintenance flow.** Treat each forced publication as an owner-billed manual refresh
  unless a platform payer is decided.
  - Pre-check every affected owner: Active state, credits covering the listed per-file costs,
    about 2× the state size in free storage, and 20 or fewer files per owner at a time.
  - Freeze editing before draining, so the 60 s idle and flush handoffs succeed.
  - Clear stale `refresh_error` values and request manually.
  - Wait for zero `source_refresh`, `parse` and `ingest` jobs.
  - Verify every Office file has `checkpoint = indexed_checkpoint` and an empty
    `pending_effects` before deploying.
  - Then bump the epoch and reseed, as the handoff review says.
  - Owners who cannot be billed or are locked need an explicit decision, or their edits become
    unreachable after the reseed.

## Side findings

1. **The BetterOffice DOCX export drops manual page breaks.** Repro and measurements are above.
   The effects are a large re-embed, shifted pages and citations, and a permanent layout change
   once published. The fix is `0f1ab4a7`, on the port list.
2. **`resolve_source_change` cannot caption a new image.** `models.caption_image` calls
   `registry.captioning_spec()` before anything else (`models.py:875`). That needs job pins,
   and only the ingest worker sets them (`worker.py:1674,1731`). In the retrieval service the
   call raises `RegistryError` before any provider call. The probe
   (`caption_pin_probe.py`) showed 0 provider calls. Only captions that already exist are
   returned. `test_pending_sources.py:218-276` mocks `caption_cache.caption`, so it cannot catch
   this.
3. **Dead code.** `FIGURE_PROMPT` (`prompts/captioning.py:13-17`) and the
   `source_refresh_job_id` path in `caption_cache.py:389-433` have no callers since figure
   captioning was retired.
4. **A refresh temporarily needs about 30 MB of owner storage** for a 417 KB book DOCX or an
   8.7 MB deck (measured above). This is a likely refusal cause for Free owners.

## Open questions

1. Who pays for a system-forced publication: the owner, the platform through a new payer mode,
   or the owner with a compensating usage row? What happens to owners who cannot be billed or
   are locked?
2. Is summary reuse below a change threshold acceptable, and at what threshold?
3. Should refresh parses be priced differently, or the automatic threshold scale with document
   size?
4. Does DeepSeek Flash actually accept a ~325k-token single request within the 120 s ingest call
   timeout? This is unverified because it would be a paid call. How much of a refresh summary is
   billed at the cached rate thanks to its unchanged prefix?
5. Should forced publication wait until the export data-loss fixes are on the old engine, given
   that publishing now makes their losses permanent?

## Reproduction

The scripts are in `probes/reparse/` next to this report.

| Script | Purpose |
| --- | --- |
| `make_book_html.py` | builds the book and chapter HTML, which are converted with `soffice` in the parser image |
| `bo_edit.mjs`, `bo_edit_generic.mjs` | headless edit and export |
| `parse_and_compare.py`, `reuse_matrix.py` | parse and compare chunks |
| `bo_pagebreak.mjs` | page-break repro |
| `bo_timing.mjs`, `bo_sizes.mjs`, `bo_seed_det.mjs` | timing, size and determinism measurements |
| `summary_budget.py` | summary budget computation |
| `caption_pin_probe.py` | chat-time caption probe |

Run the Node scripts from `collaboration/` and the Python ones with the repo `.venv`. The parser
container `reparse-probe-parser` was removed.
