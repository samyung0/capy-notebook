# Knowledge base plan

Status on 2026-09-16: Epo authorized implementation and testing of the complete local parsing and ingestion pilot, with an Astra xhigh subagent. This supersedes the earlier planning-only pause. Shared chat compaction and capture-lifetime changes already exist; application library tools and curate mode remain separate integration work. This file consolidates the research reports, outside review, attached discussion and subsequent decisions. The decisions themselves are recorded in `human/agentic-retrieval.md`.

## Completed local pilot, 2026-09-16

The fresh end-to-end run finished with recorded errors, using DeepSeek Flash
with thinking off as Epo selected. Three books produced 1,474 parsed pages,
3,679 indexed chunks, 1,892 valid excerpt tags, three book summaries and all
48 A/B study responses for the 24 frozen questions. Two tag responses remain
schema-invalid. Four study responses failed figure attribution checks; the
remaining 44 were exported. Original failed responses and usage are retained,
with no repair or further retry after Epo accepted recording the errors as-is.
The local run lives in
`data/knowledge-base-pilot-v4/run`, with its own PostgreSQL container on
localhost:15437 and parser v4 on localhost:18091. The original pilot remains
available. See the [fresh run report](bench/rag/reports/2026-09-16-knowledge-base-v4-pilot.md).

The ODL corrections are already applied to shared application code, including
ordinary uploads: parser `odl-2.5.7-refined-rapidocr-v4`, parser-client identity
v4, and chunker v10. All 30 implementation files still match the exact snapshot
that passed 159 focused checks and the broader textbook/control experiments.
These changes are local and uncommitted; this task has not deployed them to the
shared ingest host. Deploying both parser and pipeline is required to activate
the full change there. Existing indexes are not retroactively repaired.
The old `capy-kb-parser-pilot` container contains v3 for the original baseline;
the new `capy-kb-parser-v4-pilot` container was built and checked as v4.

The fresh parser records match the verified v4 candidate exactly. The frozen
12-tag sample has plausible classifications, but 467 tags remain in the wider
review queue. Review of the six selected study cases found numerical and
instructional errors despite valid schemas. Topic assistance changed the
retrieved set for 11 of 24 questions; this run does not establish a quality win.
The source-grounded [study review](bench/rag/reports/2026-09-16-knowledge-base-v4-study-review.md)
records all 12 selected A/B outputs, including the rejected box-plot response.

The run demonstrates local pipeline feasibility. Further work before a public
library includes study-quality controls, source/catalog review and application
integration. Automatic selection and replacement of damaged regions by LLM
transcription remains a separate experiment; this run used fixed ODL output.
Broader textbook acquisition should follow the requested source inventory.

No additional database, B2 bucket, source selection or credential handoff is
needed from Epo. Production library integration and broader textbook acquisition
remain outside this local feasibility run. DeepSeek is the selected pilot
generation/transcription model; embeddings retain the DeepInfra Qwen3-Embedding-4B
pin. This local configuration does not modify production application model pins.

## Library database, 2026-09-17

Epo chose the shared-instance shape: one dedicated pgvector Postgres on the
Netcup ingest host (`capy-library-db`, WireGuard `10.77.0.2:5433`), shared by
UAT and production, versioned datasets with a per-environment pin, schema
owned by the library loader, read-only role for app environments, SSH tunnel
from the developer PC. It is deployed and verified: pgvector 0.8.6, owner and
reader roles, reader denied writes, listener bound to WireGuard only, nightly
local dumps. Setup and URLs are in the
[runbook §7.3](openwiki/deployment-runbook.md). The builder's transcription
model is Claude Sonnet 4.6 at medium effort through the headless CLI on the
developer's subscription, with GLM-5.3-Flash at high through TokenHub as the
switchable alternative; DeepSeek is dropped from the builder. Quality is best
effort with periodic manual checks by higher-end models. No deployed service
reads the library yet; that arrives with the curate-mode integration.

### Library schema and loader

Published 2026-09-17: the three pilot books from the completed v4 run, each as
book version 1, in 108 seconds through the tunnel: 3,679 chunks and vectors
(3,585 searchable), 1,894 excerpts, 875 figures, 32 topics, four model-run
receipts per book. The production hybrid search runs unchanged against the
library: two of four frozen questions return the pilot's exact top five, and the
other two return the same or overlapping chunks in a different order. The pilot
database reproduces its own baseline exactly, and the copied vectors and
tsvectors are identical, so the difference is the lexical leg: it orders
candidates by all-terms match and `ts_rank_cd`, and in these queries 35 of 44
adjacent lexical scores tie, which the chunk-id tiebreaker now settles. The
library uses exact vector scans like the pilot; an HNSW index is added when the
corpus outgrows them.

Versions are per book, not per dataset (decided 2026-09-17, superseding dataset
versions and environment pins). The database holds one live workspace,
`library`, with one file per book. `library_books` keyed by id carries the
current `content_id` and `version`; `library_book_versions` carries every
publish with its status (`current`, `retained`, `retired`) and receipts (source
run, corpus identity, parser release and fingerprint, chunker, bucket object
key, note). Chunks, vectors, excerpts, figures and model runs are keyed by
content id; the topic catalog is library-wide. `rag_file_contents` points each
book at its current content, so retrieval sees exactly that, the way workspace
search does. Library-owned rows keep what a reviewer needs to locate and
reparse: book identity and licence, excerpts (chunk ids, pages, regions, figure
ids, text, tag outcome with roles, topic ids, confidence, evidence and its
verification, synopsis, proposed topic, review reasons; failed tags keep their
excerpt), figures (page, bbox on the page-1000 grid, caption bbox, original
caption and footnote, exclusion, local capture path) and model-run receipts.
Topic assignments live inline on the excerpt because nothing edits them yet.

The loader is [`knowledge_base_library.py`](bench/rag/scripts/knowledge_base_library.py),
run on the developer PC through the SSH tunnel: `schema` creates the schema,
`publish --run <run> [--book <id>]` loads a book's content under a new content
id, records its next version, retains the previous one and swaps the pointer in
one transaction (refusing a corpus identity the current version already holds,
and a book the knowledge-base bucket does not hold), `rollback --book
--version` points a book back at a retained version, `retire --book --version`
drops a retained version's content rows, and `status` lists books with their
history.

### Library retrieval, 2026-09-17

Decided: hybrid search breaks ties on the chunk id (implemented and tested),
and library retrieval gets its own unit and taxonomy with the curate prompt
shaping role-specific requests. The [retrieval experiment](bench/rag/reports/2026-09-17-knowledge-base-retrieval.md)
on the published version measured what that should look like. Plain search
puts every first hit on an expected topic but reaches an expected role only
58 of 110 times, and role-phrased query rewrites do not move that (54 of 110):
the ranker does not hear roles. Filtering on verified tags is what supplies
them, and the number that says so is not the filtered arm's 102 of 102 — that
arm was handed the expected topics and roles, so its columns are true by
construction — but the gap it exposes: no verified exercise excerpt on
Bayesian inference in these three books. Browsing the tags alone covers every
expected role for 21 of 22 questions with a median of 141 excerpts per topic
set, far too many to read without ranking. Proposed and pending decision:
`search_knowledge(query, topics, roles)` with the predicates in SQL and
excerpt-level results, a `browse_knowledge(topic)` listing with counts by role
and book, the 32-topic catalog in the tool description so the model maps
learner phrasing to topic ids, and the curate prompt deciding which roles a
request needs.

Decided and implemented 2026-09-17: `pipeline/retrieval/library.py` (reader
pool, `search` with the verified-tag predicate inside the hybrid search
statement and excerpt folding, `browse`, `read_excerpt`, `provenance`,
`capture_target` and the schema the loader imports), `LIBRARY_DATABASE_URL` and
`CAPY_LIBRARY_TAG_MIN_CONFIDENCE` in the pipeline config, integration tests,
and the module as a sixth arm of the experiment. Its topic and role columns are
tautological (the labels were the predicates); what it established is that the
corpus fills a full five-excerpt request for 21 of 22 questions, and that the
twenty-second comes back empty with the Bayesian exercise gap named in its
available-roles counts. It beats the post-hoc filtered arm on `stat-19` (five
excerpts instead of two) because the predicate applies before the candidate
cut. Re-measured unchanged against the per-book-versioned live library.

Implemented 2026-09-17 (phases 0-2 of
[the curate-mode plan](artifacts/2026-09-17-curate-mode-plan.md)): the agent-tool
contract with `library.read`, `search_knowledge`, `browse_knowledge`,
`read_knowledge` and `create_material.excerpt_ids`; `conversations.curate` fixed
at creation with the gateway rejecting a disagreeing request and the chat panel
toggle; the pipeline curate loop (handlers over `library.search/browse/
read_excerpt`, the topic catalog on `browse_knowledge`, the progress ledger,
the stall guard, four calls per response with no per-turn or planning cap, the
200,000-token window check, the curate prompt and a plain-prose answer with no
citations); and `materials.provenance` written from `library.provenance`,
validated in Go with the ShareAlike licence rule and rendered as a footer
outside the editable document. Phase 6 replaced dataset versions and environment
pins with per-book versions on one live library, which the loader, the reader,
the ops Library section and the retrieval eval now use.

Fix round 1, 2026-09-17, after the first reviews: contract version 6 adds
`create_ledger {body, todos}`, a `todo` on `create_material` and
`edit_document`, and `excerpt_ids` on `edit_document`. The ledger is now a tool
the model calls with a body and up to twelve todos; a write marks its todo done.
The stall guard counts four consecutive responses that complete no todo, a
repeated read is not progress, and there is no planning ceiling. Writes accept
only excerpt ids the turn read, and require them once the turn has read
anything. Curate has no capture cap. `read_knowledge` pages in chunk indexes.
Every curate-mode prompt and tool description lives in
`pipeline/pipeline/prompts/curate.py`.

Fix round 2, 2026-09-17: the ledger is the conversation's, not the turn's. It
lives in `conversations.ledger`, arrives on the stream request, and the pipeline
writes it back through the gateway at turn end, however the turn ended. Each
user message may call `create_ledger` once — the call appends that message's
request and its todos — and a second call is refused instead of replacing
anything; open todos and the materials created carry to the next message. `todo`
is required on a curate write to a material and refused when it is out of range
or already done, so every real write is progress and the stall guard measures
work rather than tool traffic. A turn ended by the guard reports its own stop
reason, `curate_stall`. None of the curate write rules reach an `edit_document`
on the user's own source file: it carries no todo, no excerpt ids and no
provenance. An empty topic catalog is a library that is not published and
refuses the turn as `model_unavailable`.

### Curate mode end to end, 2026-09-17

The playground ran one real curate turn against the live library
(GLM-5.3-Flash at low reasoning via TokenHub, request: a high-school beginner
wanting to learn and practise linear regression). What was real: the
production agent loop, the curate prompt, the library tools over the live
library through the tunnel, the ledger and the stall guard. What was not: the
two writes went to the playground's local stubs, which save a JSON file and
return the receipt the gateway would have produced, so nothing was persisted,
authorized or quota-checked, and the run carried the config's placeholder
workspace id rather than a real workspace.

Eight planning responses, 16 tool calls (browse_knowledge 2, read_knowledge 12,
create_material 2). Output: a note "Linear Regression — Beginner Study Guide"
(about 1,700 tokens, 12 excerpts) and a 15-question multiple-choice quiz (10
excerpts), both grounded in Advanced High School Statistics chapter 5 with
provenance recorded (one book, CC BY-SA 3.0, version 1). Usage: 129,667 input
tokens (35,456 cached), 5,026 output. Receipt:
`lab/playground/local/runs/20260917-124642-8c0c66/run.json`.

Four parts of the design were therefore not exercised at all: no
`search_knowledge` call (the model browsed and read only), no
`capture_knowledge_page` call, no compaction (the turn never reached the input
limit) and no stall (every response added to the ledger). The model also wrote
the whole note in one creation instead of growing it section by section. That
run predates the ledger tool, the todos and the read-before-write rule; it says
the loop runs end to end, not that the current shape does.

## Goal

A user in their own workspace says "I want to learn cell mitosis". With curate mode on, the chat agent reads a shared library of pre-ingested open textbooks and creates a small set of materials in the user's workspace: a note, a quiz, flashcards, maybe a study plan. Like NotebookLM, except the sources come from a library we control and have inspected.

## Decided (Epo, 2026-09-16)

| Decision | Consequence |
| --- | --- |
| Library scope is open textbooks, undergraduate and below, English. No region or exam targeting. | Book selection is by subject coverage and licence, nothing else. |
| The first pilot runs its data pipeline on this PC with existing model APIs. | Use an isolated local parser, Postgres index and PDF directory. The existing remote `lab` and `uat` playground targets are not this local pilot. |
| Pilot and selective-recovery model calls use the normal DeepSeek Flash API with thinking disabled; embeddings use prepaid DeepInfra. | Persist each request/response and usage, reuse completed outputs, and explicitly retry failed requests when needed. This supersedes the earlier Qwen generation-model choice. Retain the Qwen3-Embedding-4B pin. |
| No additional pilot spending ceiling; no generated image captioning. | Record usage and actual cost. Preserve author-written captions and figure links. The existing application credit policy is unchanged. |
| Codex chooses the pilot books. Inventory available textbook sources after testing, before broader acquisition. | No subject-selection question is needed. Keep the pilot small and use its findings to define the inventory fields. |
| No live external retrieval at question time. Everything is pre-ingested. | The Wikipedia, Commons, Openverse and web-search sections of the strategy report are dropped. Latency and offline goals are untouched. |
| Curate mode is a user toggle on the chat agent. On: library read tools plus material creation into the user's workspace, and the generate tool lives here. Off: only the workspace's own files. | The library is never a workspace scope. Citations or attribution attach after materials exist in the user's workspace. |
| The library embedding pin is fixed and independent of workspace pins. | A query is embedded once per index searched. Re-embedding the library is a rebuild into a new index followed by a swap. |
| Ingest volume and speed are not a product-design constraint. | Rented machines remain an option for later expansion. Measure this PC's actual parse time and peak memory in the pilot; prior host estimates are not local measurements. |
| Attribution is a visible footer on every curated material, one line per source book. | Stored as a provenance column on the material and rendered by the frontend, outside the editable document, so it cannot be deleted. If any source is ShareAlike, the footer also states the material's own licence. |
| The library has its own tool family (`search_knowledge`, `read_knowledge`, `capture_knowledge_page`), separate from `search_workspace`, and several calls are allowed per model response. | The one-search-per-response rule stays for `search_workspace` only. |
| The library embeds with Qwen3-Embedding-4B, the current workspace default. | One query embedding serves both indexes while the pins coincide. Library ingest embeds in batch; DeepInfra latency only matters at question time. |
| Postgres for records and vectors, B2 for PDFs, as today. | Tens of GB for about 1,000 books. |

Selected pilot model: DeepSeek V4.1 Flash, API alias `deepseek-flash`, through `https://api.deepseek.com/responses`, with `reasoning.effort: none` and `stream: false`. Persist per-request intent, response, timing and usage; completed results are reused, while failed/uncertain attempts require an explicit retry and retain their earlier receipts. An uncertain call may still be billed by the provider. Earlier Qwen normal and Batch files remain historical evidence. The runner reads credentials only from ignored `data/knowledge-base-pilot/secrets.env`; keys never belong in reports or tracked fixtures. Native JSON Schema is supplemented by local shape/provenance checks. [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/).

The following implementation details remain proposals. Assistant recommendations in `knowledge-base-review.md` are not additional user decisions.

## What already exists and gets reused

- Parser and ingest: OpenDataLoader parse with page and bbox per block, heading-aware 400-token chunks, hybrid search (pgvector halfvec 2560 plus Postgres lexical, RRF), per-file cap of 4.
- `capture_page` renders a page or bbox from the source PDF at question time. Figures need no separate image store for the pilot.
- Chat tools with one contract across Python, Go and the frontend: `search_workspace`, `list_sources`, `describe_documents`, `read_document`, `capture_page`, `create_material` (quiz, flashcards, mindmap, diagram, note), plus inspect, edit, trash and restore.
- The fixed Generate workflow at `/generate`, outside the agent loop.
- The ops app under `ops/` with operators, role tokens, audit events, and pages for overview, health, ingest host, registry, costs, users, reconciliation and audit.
- Public workspaces readable by any signed-in user, with chat.
- The playground under `lab/playground` running the production agent against the lab or UAT index.

## Design as it stands

### Library storage

The proposed storage implementation is a system-owned workspace (kind `library`) in the existing files, chunk and vector tables with a fixed pin. It is never a user-selectable workspace scope; only curate-mode tools read it. The pilot uses an isolated local database and benchmark metadata before committing to production tables. Proposed library-specific tables sit beside the existing tables:

| Table | Holds |
| --- | --- |
| `library_books` | title, authors, edition, source URL, licence, attribution text, PDF blob, sha, status, published version |
| `library_excerpts` | book, section path, page range, chunk ids, teaching role (introduction, formal, worked example, exercise, summary), figures |
| `library_figures` | excerpt, page, bbox, original caption, credit, excluded flag |
| `library_topics` | id, label, aliases, scope note, broader and related ids, status (proposed, active, merged into) |
| `library_topic_assignments` | excerpt, topic, origin (model or operator), confidence, model run |
| `library_overrides` | excerpt, topic, add / remove / confirm, operator, reason, time. Applied last on every rerun |
| `library_relations` | excerpt pair, kind (exact, near copy, paraphrase, alternative, conflict), evidence spans |
| `library_review_items` | kind, payload, open / accepted / rejected, operator |
| `library_model_runs` | provider request ids, stage, books, status, usage, result paths |

Infrastructure recommendation: use one disposable local Postgres database for the pilot, with pgvector and PDFs/artifacts on local disk. Codex can prepare this in Docker; the developer does not need to buy a database service or provision a B2 bucket. For application integration, the target environment's app Postgres instance can hold the proposed library records and vectors. Production storage still needs provisioning when that environment is set up; a dedicated knowledge-base database server is optional. That environment's private B2 bucket can hold library-owned objects under a distinct prefix, provided reference tracking and cleanup retain editions used by saved materials. A prefix organizes objects; access checks and lifecycle rules still need to enforce library ownership. A separate database server or bucket is justified only by a later isolation, retention or operational requirement.

### Book lifecycle

admitted (PDF plus licence record) → parsed → indexed → tagged → in review → published → retired.

Only published books are searchable. Publishing a new edition retires the old one. Material provenance keeps pointing at the edition that was used.

### Ingest stages new to the library

These describe library implementation stages. The pilot starts with source excerpts and model-proposed tags through normal API calls with thinking disabled. Independent editorial review remains visible as a separate status. The full relations pipeline can wait for evidence of retrieval duplication.

1. Excerpt building from the parser's heading tree. A section keeps its equations, worked example and figures together. Search chunks point back to their excerpt.
2. Role and topic assignment. One model call per excerpt with a bounded candidate topic list derived from tables of contents. A new topic is proposed only when nothing fits. Uncertain assignments become review items.
3. Relations. Hash, then MinHash, then embedding neighbourhood nominate pairs. A model call classifies only nominated pairs and returns evidence spans. Uncertain pairs stay separate.
4. Stages 2 and 3 use normal API calls with bounded concurrency and durable per-request results. Parse, chunk and embed retain their existing paths.

The earlier per-book cost estimate is not a measured budget. Token volume depends on excerpt size, candidate-pair count, output length and repeated calls; embedding and query-time generation add separate spend. Confirm current rates and account access, then report actual tokens and cost by stage. Use normal API rates after the transport switch. Pending calls, failed responses, schema-valid responses and independently reviewed content remain distinguishable.

### Curate mode in the chat agent

- Toggle per chat. Off is today's behaviour. On adds `search_knowledge`, `browse_knowledge`, `read_knowledge`, `capture_knowledge_page` and `create_ledger`, and keeps `create_material` and `edit_document`. Knowledge tools resolve to the library index, never to a workspace scope, and may be called several times in one model response.
- Coherence rule: one primary excerpt per material section. Another book's excerpt fills a named gap only after checking terminology and notation. A worked example is never split.
- Provenance: `create_material` and `edit_document` take the library excerpt ids the content was written from. Go persists them as the resource's provenance and renders a footer from it: one line per book (title, authors, edition, licence, URL), an "adapted from" notice, and the work's own licence line, which is the newest ShareAlike version of a single copyleft family across its sources; sources from two copyleft families refuse the write (decision 2026-09-17). The footer is a column on the material, rendered by the frontend outside the editable document, so it cannot be deleted.
- No citations. Curate mode ignores the final answer's passages server-side. The reply is the list of created materials with their receipts. Under the existing retention rule, library evidence is then dropped from conversation history after the turn; provenance on the material is the durable record.
- Budget (decided, implemented): curate mode has no per-turn tool count and no planning-response ceiling for any payer, allows 6 tool calls of any kind per model response, and requires a model window of at least 200,000 tokens. Live compaction keeps the query, one turn note of at most 12,000 tokens and the last two tool exchanges exact. The stall guard is the workload bound: after four consecutive responses that complete no ledger todo the next response runs with tools off and the turn reports `curate_stall`; each of the first two errored `create_material` or `edit_document` calls in a turn grants two more responses (2026-09-18). The credit guard stays a platform-paid billing cutoff and bounds nothing else; ordinary chat retains its current caps. The developer chose no additional monetary ceiling for the bounded pilot. Its fixed corpus and request set still define the experiment; record all calls and costs and do not treat that choice as removal of application credit rules.
- Measured (2026-09-16, synthetic text and summarizer, see `bench/rag/reports/2026-09-16-turn-fold-capacity.md`): the 200k-window simulation completed 96 sections, retaining 46 section fact codes at the end; its first fact loss occurred after section 58. That experiment retained captures as a standing charge and predates the new capture-lifetime behavior. It establishes neither real summarizer accuracy nor end-to-end curate quality. Models below 200k are out of scope for curate mode by decision.
- Progress ledger (decided, reshaped 2026-09-17): a ledger the conversation keeps in `conversations.ledger`, never compacted, riding outside the messages like captures and rendered right after the query. Each user message calls `create_ledger` once with a body restating that request and up to twelve todos, one per material or section; a second call in the same message is refused. `create_material` and `edit_document` on a material require the index of an open todo and mark it done. Open todos and the materials created (id, kind, title, size) carry to the next message; excerpt reads are the turn's only and render under the todos as inputs read. Storing it keeps only the open todos, the last 50 materials and the last 5 requests, so a term-long conversation stays under the gateway's 64 KiB cap; the kept todos are re-indexed from 0 and the rendered ledger tells the model to use the numbering in front of it. A stored ledger Python cannot parse is logged with the conversation id and the turn starts empty. The note ceiling stays at 12k.
- Captures (decided and implemented 2026-09-16, both modes): a capture lives as long as its exchange is kept verbatim and is dropped when that exchange folds; the note keeps the numbers read from it in text.

### Figures

Source PDF plus page, bbox, original caption and credit, rendered on demand through the existing capture path. A separate asset store for crops waits until materials embed images or exports need them. No generated figure descriptions: textbook captions are author-written and specific, and the excerpt link already carries the sentence that refers to the figure. Revisit only if the pilot shows retrieval failures on figures whose caption is a bare number.

### Operator control: a Library section in the ops app

| Page | What an operator does there |
| --- | --- |
| Books | See lifecycle status, licence, edition, counts. Admit, reparse, re-tag, publish, retire. |
| Model runs | See stage, request status, token usage and retained results. Explicitly retry failed requests. |
| Topics | Rename, add alias, edit scope note, merge (leaves a redirect), split, deactivate. |
| Review queue | Accept or reject with a reason. Accepting a new topic creates it. Accepting an assignment writes an override. |
| Excerpt browser | Browse by book or topic. See role, topics, figures (rendered from the PDF), relations. Override inline. |
| Try search | Run the library search exactly as curate mode would and read what comes back. |

Every mutation lands in `operator_audit_events`. Reruns replace model-origin rows and never touch override rows. The pilot runs without this UI, using local benchmark metadata and the runner described below.

Decided 2026-09-17: the first Library section is read-only. It exists so the developer and other LLM reviewers can scrutinize what the builder produced, not to edit it: books, excerpts, chunks, tags, figures, recovery overlays and model runs, each carrying its locators and provenance (book sha256 and edition, PDF page, bbox on the page grid, chunk and excerpt ids, parser/chunker identity, dataset version, model run and request ids, usage and source hashes) plus a machine-readable per-book export, so a reviewer can find the source region and reparse it independently. Mutations in the table above wait for a later decision. The ops service reads the library through the reader role over WireGuard, which adds an `OPS_LIBRARY_DATABASE_URL` entry to `deploy/env-manifest.json` when it lands.

### Learner adaptation and catalog review

The discussion favors learner-specific assessment during the agentic loop, using recent answers, scores and study progress to select explanations and exercises. The mechanism remains a proposal: preserve attempts as observations, treat inferred difficulties as revisable, ask a diagnostic question when evidence is insufficient, and link exercises to source evidence and the skill being practised. This does not require an exhaustive prerequisite graph at ingest time. The first corpus comparison does not require real learner histories; adaptation can be evaluated separately with explicit example histories later.

Catalog preparation starts from the books' headings, indexes and learning objectives. Each proposed topic has an id, label, aliases, scope and source examples; an excerpt can belong to several topics. Codex can prepare assignments and an exception list for ambiguous boundaries, topic merges and apparent conflicts. This is a proposed editorial workflow, not blanket authority to publish the catalog or delete alternatives. Source explanations and their figure links survive semantic grouping; grouped alternatives do not inherit each other's figures.

## Pilot

1. Codex selects three books in one subject: two overlapping, one at a different level. Record exact editions, download URLs, hashes, licence evidence and any figure exclusions. The developer accepts any suitable textbooks within the agreed language/level scope. Prefer accessible published downloads so manual PDF upload is unnecessary.
2. Prepare an isolated local parser and Postgres database with local PDFs. Reuse the parser, chunker, embedding pin and hybrid ranking. Keep scripts under `bench/rag/scripts/`, inputs under `bench/rag/fixtures/`, and dated results under `bench/rag/reports/`; large local artifacts must be gitignored. B2 remains the proposed application store, but bucket provisioning is not a prerequisite for this local corpus experiment.
3. Build a benchmark runner or explicit local playground target. The existing playground reads remote indexes and offers read tools; it does not provide the planned library catalog or the complete curate/material-persistence flow. Initially save generated study material and its provenance as local artifacts. App material writes, fixed attribution rendering, the ledger and the stall guard need a separate integration check after implementation.
4. Freeze 20 to 30 requests shaped like "I want to learn X", with a third held out from catalog building. Include unanswerable requests, alternative learner levels, and figure-dependent questions. Score source support, coverage, coherent definitions and notation, figure fit, repetition and attribution; report parse/index time, peak memory, model tokens and cost. Source-check the results; an agent's own score is not independent human validation.
5. Arm A is existing hybrid search. Arm B adds role and topic tags. Report whether tags are merely model-proposed, agent-reviewed or independently reviewed. Keep the corpus, excerpt/figure links, generation instructions, model and comparable budgets identical so the tags are the changed variable. Treat B as the combined tag intervention, without claiming that the result isolates roles from topics. Duplicate-aware selection is a later comparison only if A shows repetition; keep substantive alternatives and never erase a difference solely because embeddings are similar.
6. Use the results to choose which proposed library tables and tooling are justified. Successful corpus retrieval does not by itself validate app authorization, provenance persistence, learner adaptation or long curate turns.

## After the pilot: textbook source inventory

Before acquiring a larger corpus, collect a searchable list of available textbook sources. Prefer published catalog APIs, CSV/JSON exports and feeds; use bounded website crawling when a source provides no suitable export and permits automated access. This stage inventories candidates and does not automatically download, parse or embed every listed book.

Record the catalog and original publisher, canonical book URL, title, authors, subject, language, stated level, edition/date, available formats/download links, declared licence and its evidence URL, figure exceptions where known, and access/check date. Deduplicate catalog entries by original book and edition while retaining every discovery source. Mark unclear rights or missing metadata for review. Use the pilot's extraction and retrieval findings to prioritize formats and subject gaps. The inventory comes after testing as requested.

## Readiness check, 2026-09-16

Initial checks followed the pull of `main` to `b79795b`. Epo subsequently supplied temporary local keys and authorized full pilot execution. The following records readiness, not a claim that the full pilot has passed.

| Item | Observed state | Owner / next action |
| --- | --- | --- |
| Local runtime | Docker 27.5.1 responds. The current parser image has been built and started locally on port 18090; isolated pgvector Postgres runs on port 15436. Java, Python, uv and the repository virtualenv are available. | Codex runs serial book parsing and measures local resource usage. No manual Docker installation is needed. |
| Model credentials | Epo supplied Alibaba and DeepInfra test keys directly. They are stored in ignored `data/knowledge-base-pilot/secrets.env`. | No additional credential handoff is needed. Live endpoint/model checks remain necessary. Epo plans key rotation after testing. GitHub secrets metadata alone cannot provide their stored values. |
| Existing remote credential route | The playground expects `~/.ssh/id_ed25519_capy_ingest`; that file is absent here and its SSH probe failed authentication. | A local pilot does not need this SSH key if model credentials are supplied directly. If credentials already live elsewhere, identify their location rather than provisioning another account. |
| Models and spend | Normal Qwen3.8-Flash with thinking off and DeepInfra Qwen3-Embedding-4B are selected. No additional pilot spend ceiling is required. | Codex verifies live responses and embedding access, recording actual usage. Historical Batch results may be reused. |
| Corpus | Downloaded three complete statistics books: OpenIntro Statistics 4e, Advanced High School Statistics 4e, and Learning Statistics with jamovi 2025 author build. Total 1,474 pages. Exact hashes, licence evidence, source lineage and figure exceptions are recorded in the book manifest. | Codex prepares the initial catalog and frozen requests. Broader source inventory follows testing. |
| Test implementation | Astra xhigh implemented the resumable local runner using production parser/chunking/embedding/search components. All three books are parsed and indexed; the async tagging jobs are accepted. | This verifies the data path. Application queue, authorization, B2, immutable material attribution and curate-agent integration require later app checks. |
| Quiz growth | `edit_document` already accepts `add_question`, with up to 20 commands per call; the gateway translates it to a quiz child insertion. | Reuse the existing operation and check append order, content limits and provenance during integration. A 200-question run has not been tested. |
| Human review | No independent review of candidate assignments or generated study materials has occurred. | Codex prepares reviewable examples and flagged exceptions. Developer reviews the sampled outcomes before treating agent-assessed quality as validated. This need not block environment preparation. |

### Manual work and execution boundary

- No manual database or bucket provisioning, additional spending limit, subject choice or key handoff is currently required. Local runs need this PC and Docker; the tagging continuation has stopped on a failed result, as recorded below.
- Execution is authorized. Codex handles local services, downloads, parsing, embeddings, normal model calls, retrieval comparison and result packaging.
- Epo reviews sampled source assignments and generated study materials before treating agent-assessed quality as independent validation. This does not block the local test.

A full ops UI, B2 setup, exhaustive topic tagging and learner-history integration are outside this first corpus comparison. The normal API is the selected model transport; failed calls or invalid outputs remain explicit and prevent a completed-stage claim.

### Pilot checkpoint

The [local pilot report](bench/rag/reports/2026-09-16-knowledge-base-local-pilot.md) records successful parsing of all 1,474 pages, 3,861 indexed vectors and 24 completed baseline searches. Successful parser receipt times total 229.31 seconds, with a 2.58 GiB container peak. All 12 asynchronous tagging batches are accepted and processing; the tag comparison and generated study samples remain pending. Embedding calls used 1,081,946 tokens, a calculated USD 0.021639 at the checked list rate. A temporary process-local route to a responding DNS address resolved the observed upload failures without changing TLS verification or system DNS. The finite continuation is running with a five-minute poll interval and a fixed 48-hour deadline; it collects the accepted jobs and then runs the dependent comparison, summary and material stages. Its live status is in `data/knowledge-base-pilot/run/driver-state.json`. Nineteen offline tests passed. Source inspection found noisy heading paths, flattened formula structure and an actual textbook typo. These are preparation-quality issues distinct from learner-specific assessment; proposed editorial handling is an exception queue that preserves original source text and stores reviewed corrections separately.

### Parser quality review follow-up

Subsequent pilot status: the finite continuation stopped with `failed_shards` in tagging. The first collected shard contains 199 valid responses and one `invalid_json` response, with partial results preserved. This supersedes the processing/running checkpoint above. The tag comparison and study samples remain incomplete; the parser experiments below do not resume or modify those jobs.

The [September 16 ODL review](bench/parsers/reports/2026-09-16-odl-textbook-quality-review.md) distinguishes native formula damage from downstream deletion of correctly extracted text. The repeated-text filter removes body formulas, including a square root and a standard-error result; the resulting chunks can still score 1.00 or 0.952 without reasons. A saved-block replay reproduced all 1,341 OpenIntro chunks and confirmed that disabling five implicated filter keys restores the missing text while leaving separate fraction-layout damage visible.

Proposed next work is an occurrence-specific furniture experiment, an independent running-header metadata experiment, structural-risk review routing, then bounded symbol-font and fraction-geometry repairs. Low-confidence-only Batch review is insufficient; candidates also need structural flags and a sample of high-scoring passages, with source pages available for visual verification. These are review recommendations, not newly approved parser behavior. The active pilot remains the original comparison baseline.

The [expanded structure baseline and Batch proposal](bench/parsers/reports/2026-09-16-odl-structure-baseline.md) measures source-matched running banners in 606/1,311 OpenIntro and 690/1,389 AHSS searchable chunk paths. Two visually reviewed AHSS diagram labels also become ancestors of 462 chunks. These are scoped metadata defects, not body-text error rates. Proposed visual Batch transcription should preserve literal formula notation and table cell strings, with separate region-detection and transcription checks; native equation labels alone select nothing in these three books. Alibaba documents Qwen3.8-Flash image Batch and Base64 input support, so a small crop test does not require a new bucket. At that checkpoint no visual transcription batch or production repair had been run; the authorized follow-up below supersedes it.

### Shared-parser recovery experiments

The developer requested actual recovery experiments for ordinary parsing as well as the knowledge library, with Astra xhigh reviewing ODL and an independent local MinerU pipeline comparison. The [ODL recovery report](bench/parsers/reports/2026-09-16-odl-textbook-recovery.md) records five of five missing fragments restored, four of five false-parent witnesses corrected, and twelve historical heading checks preserved. It tests saved post-table bundles through the shared packer. Native fractions remain damaged; fresh parser integration and new source-family checks are still required before selecting production changes. Restored interior text can include boilerplate and increase retrieval tokens.

The [MinerU comparison](bench/parsers/reports/2026-09-16-mineru-pipeline-comparison.md) completed two passes on 28 matched source pages with CPU-only pipeline models. Selected formula checks improve from 1/5 to 5/5, but the warm parser time rises from 17.75 to 353.88 seconds (19.9 times longer). Japanese table structure, source digits and answer ordering still fail in inspected examples. Formula gains do not establish coherent exercises or exact table transcription. At that checkpoint only benchmark work had run. The subsequent shared fix below changes parsing and packing; a transcription backend switch remains unselected.

### Approved shared fix and selective transcription test

Epo authorized implementing the ODL fix, selective MinerU recovery testing and additional textbook sources. The [shared-fix report](bench/parsers/reports/2026-09-16-odl-shared-fix.md) records the parser v4 / chunker v10 implementation and fresh full-book checks on 2,206 pages, including Exo7 and Hefferon source families frozen before candidate inspection. Source-backed heading correction and interior occurrence retention apply to ordinary parsing as well as the knowledge library. Native mathematical reconstruction and calibrated confidence remain unresolved. Existing indexed pilot data has not been rebuilt.

The [selective comparison](bench/parsers/reports/2026-09-16-selective-recovery-comparison.md) uses 16 manually chosen visual regions, including six formula tables, for MinerU CPU pipeline and Qwen3.8-Flash asynchronous Batch. Qwen receives inline image bytes; no new bucket is required. Selection and crop recall remain untested; transcription success alone will not establish safe automatic replacement. Results and actual provider completion are recorded in that report.

Final shared-parser verification completed on all five books: 159 focused checks pass; the frozen current-code rerun matches the initial candidate's content and complete chunk records. New-family source checks improve from 16/27 to 25/27, with two structural failures retained for review. MinerU passes 50/57 mathematical checks but only 1/6 complete tables, so automatic whole-table replacement remains unsupported. Qwen transcripts and actual usage are still pending. A verified hidden local collector polls the two existing comparison jobs every five minutes for at most two hours, saving transcripts and usage if they finish. Its status is `bench/parsers/reports/local/2026-09-16-selective-recovery/r2/watch-status.json`; collection does not adjudicate correctness. The remaining comparison work is source review of those outputs, or resuming collection if the deadline expires. No manual credentials, database or bucket setup is needed for this experiment.

A headless Claude Code arm ran the same 16 crops twice on 2026-09-17 with
Sonnet 4.6 at medium effort on the developer's subscription login, the script
orchestrating one `claude -p` process per crop with structured output and
receipts, no live session. Run 2 passed every frozen check, including the
Hefferon `v` and LaTeX inside table cells; run 1 silently corrected the AHSS
printed `0.431` in one of two draws. The CLI loads the account's connectors
as MCP servers unless disabled, which inflated run 1 about fifteenfold, and
its median crop latency is about six times DeepSeek's. See the
[Claude Sonnet recovery report](bench/parsers/reports/2026-09-17-claude-sonnet-recovery.md).
This is a developer-machine comparison; DeepSeek remains the selected pilot
model and the ingest host still needs an API-billed backend.

Two provider arms followed on the same crops, DeepSeek Flash at reasoning
max and GLM-5.3-Flash at reasoning low through the production TokenHub
gateway. Both pass all 57 mathematical checks. DeepSeek max repeats the Greek
`ν` substitution but now flags it, at eight times the no-thinking cost. GLM
low keeps Latin `v` and LaTeX cells, misplaces one LSJ header span, and is
the cheapest and fastest arm measured, about US$0.002 for 16 crops. See the
[DeepSeek max and GLM report](bench/parsers/reports/2026-09-17-deepseek-max-glm-recovery.md).
No production transcription backend is selected by these comparisons.

### Batch recheck and broader parser verification

The requested follow-up separates local parsing from asynchronous model work.
At 11:25 UTC on 2026-09-16, both Qwen vision jobs were still pending. The earlier
twelve topic-tagging jobs had all finished at the provider. Collecting their
existing outputs yielded 2,308 JSON-decodable responses, six invalid JSON
responses and one provider HTTP 400, with no missing requests. The stopped
pilot remains `failed_shards`; collection neither validates catalog quality nor
resumes generation. The [pilot report](bench/rag/reports/2026-09-16-knowledge-base-local-pilot.md)
records the superseding status and usage. That corpus still uses v3/v9.

The [broader parser report](bench/parsers/reports/2026-09-16-odl-broad-spectrum.md)
tests the unchanged v4/v10 fix on additional full textbook families plus nine
historical multilingual/layout/OCR controls. Original-page checks are frozen
before candidate inspection; ambiguous text-only scores receive source-bound
adjudication. The 253-page controls take about 79 seconds per pass with either
version, preserving all twelve historical heading checks. Source-review results
on the additional books distinguish retained text, headings and exact table
associations. These runs validate parsing only and do not admit the benchmark
books to the library or rebuild the original search index.

Completed follow-up: biology, economics and physics add 1,931 pages, each parsed
twice per version. Fixed parser execution totals about 3 minutes 48 seconds per
pass, averaging 7.5% longer than baseline; client handling and local processing
bring the passes to 4 minutes 26 seconds and 4 minutes 41 seconds. All seven
frozen real headings survive, running-furniture corrections transfer, and
previously lost diagram labels and `K =` are restored. Biology table ordering,
an economics banner and physics fraction/exponent structure remain wrong at
confidence 0.985–1.0 without reasons. Source-bound structural and exact-math
checks remain necessary. All twelve broader inputs reproduce exactly across
passes within each version; no further production changes were made. At the
11:53 UTC API recheck, the separate Qwen vision batch still had 0/16 completed
after about two hours; its collector remains responsible for saving outputs.

### Normal API and structured output follow-up

Epo replaced asynchronous inference with normal Qwen3.8-Flash calls and thinking
disabled. The old vision collector has stopped; its 16-request Batch job reached
`cancelled`, with all 16 provider requests completed before cancellation took
effect. Its receipts and costs remain separate from the normal API experiment.
The earlier paragraphs describing a running collector are historical checkpoints.

Pilot tags, source summaries, study materials and selective transcription now
send `response_format.type=json_schema`, `strict=true`, and
`enable_thinking=false`. Schemas constrain required keys, types, allowed roles,
topic IDs and citation IDs. Local schema checks and source/provenance checks stay
in place. Alibaba lists Qwen3.8-Flash support, but the first live transcription
run returned two arrays despite an object schema. An explicit object instruction
plus the schema produced 16/16 valid objects in 17.14 seconds at four concurrent
requests. This is format compliance, not a guarantee of correct mathematics.
[Alibaba structured output](https://help.aliyun.com/en/model-studio/qwen-structured-output).

The [source review](bench/parsers/reports/2026-09-16-qwen-normal-recovery.md)
compares those outputs with MinerU and the earlier JSON-object requests. Printed
formulas and table associations still require source checks; an empty model
uncertainty list is insufficient for automatic acceptance. Request/response
receipts retain failures and explicit retries, and absent reasoning-token usage
is recorded as unavailable rather than zero.
Schema bounds such as confidence between zero and one validate the field's
shape; they do not calibrate that score. Review routing still needs structural
signals and sampled high-confidence passages alongside model uncertainty.

The pilot keeps original Batch files under `run/batches` and new strict-schema
stages under `run/models`. Schema-valid historical tags are reused only when the
source prompts match. The stronger schema found 722 historical violations,
chiefly missing `proposed_topic`, beyond the 31 failures caught by the old tag
validator. All 722 were regenerated successfully in 708.74 seconds at four
workers, using 2,253,515 input and 146,236 output tokens, an estimated CNY 2.20 at
the dated normal API rates. All 2,315 tag objects now meet the schema. Only 799
pass the literal evidence check; 1,616 enter editorial review for evidence,
confidence or topic reasons. This does not mean 1,616 assignments are wrong, but
it makes the review burden visible. The original v3/v9 corpus remains the
comparison baseline; this continuation neither reparses nor reindexes it. Live
progress is in `run/realtime-driver.json`.

The Qwen continuation subsequently stopped on source summaries: LSJ completed
in 103.27 seconds, while the other two calls timed out after 300 seconds. Their
provider outcome and usage are unknown. Independent retrieval/material stages
used the completed tags. All 24 retrieval comparisons and nine figure captures
finished. The material run stopped after repeated stalls with 18 requests
started, 12 valid outputs, six failed or uncertain calls, and 30 unstarted
requests. Receipts remain in `run/material-continuation.json`; no completed
material export occurred. The [partial study review](bench/rag/reports/2026-09-16-knowledge-base-study-sample-review.md)
found two explanatory/mathematical errors and a missing sampling assumption in
four received outputs from a frozen six-case selection. Full pilot completion
and a general teaching-quality claim remain unsupported.

Epo's [DeepSeek V4.1 Flash comparison](bench/parsers/reports/2026-09-16-deepseek-comparison.md)
used the same source requests with thinking disabled. All three summaries
completed in 6.95 seconds total; all 16 crop responses passed local schema
validation in 7.35 seconds. Source review found 57/57 correct mathematical
expressions but one incorrect table quantity label, leaving 35/36 associated
cells correct. A twelve-excerpt schema arm passed all shape checks, but five
evidence strings still failed exact-source matching. Both conflicting schema
probes were accepted and violated the schema. Provider schema parameters
therefore supplement local checks; they do not replace them. The comparison is
recorded separately and does not change the selected production provider.

The [page-prompt experiment](bench/parsers/reports/2026-09-16-page-prompt-comparison.md)
tests Epo's literal extraction prompt on 16 crops and four full pages with
DeepSeek, thinking off. The crop arm retains all 36 associated cells but loses
one of 57 mathematical targets through ambiguous radical scope. A region
revision with explicit LaTeX grouping restores that formula but changes Latin
`v` to Greek `ν` in one table label. One full-page proof also loses a limit
condition. The prompt is a useful extraction candidate; exact source
replacement and evidence quotations still require verification. These
benchmark-only captions do not change the pilot's original-caption policy.

## References

- `bench/rag/reports/2026-09-15-external-knowledge-strategy.md`
- `bench/rag/reports/2026-09-15-topic-knowledge-base.md`
- `bench/rag/reports/2026-09-15-external-search.md`
- `bench/rag/reports/2026-09-16-turn-fold-capacity.md`
- `knowledge-base-review.md`
- `human/agentic-retrieval.md`
- `openwiki/agentic-retrieval.md`
- `lab/playground/scripts/common.py` (existing remote targets and credential loading)
- `server/internal/agenttools/agenttools.go` and `server/internal/httpapi/internal_documents.go` (quiz append contract and implementation)
- [GitHub Actions secrets API](https://docs.github.com/en/rest/actions/secrets#get-a-repository-secret) (metadata is readable; stored secret values are not)
- [Alibaba Model Studio base URLs](https://help.aliyun.com/en/model-studio/base-url) (workspace-specific Beijing endpoint)

## Local builder, 2026-09-19

Epo asked for a local dashboard over two workflows, scraping and download with a
persistent queue and per-book ingestion with start and pause, and for a
three-level taxonomy (areas, subjects, per-book topics) before broader
acquisition. Decisions are in `human/agentic-retrieval.md` (2026-09-19 lines);
the plan is [`artifacts/2026-09-19-knowledge-builder-plan.md`](artifacts/2026-09-19-knowledge-builder-plan.md)
and the areas/subjects fixture is
[`lab/knowledge/subjects.json`](lab/knowledge/subjects.json),
both written for review. The taxonomy landed on 2026-09-19: `library_subjects` and `library_topics.subject_id` in the schema, the loader loading the fixture and dropping unreferenced topics, `catalog()` returning subjects with counts, `browse_knowledge` taking a subject or a topic (contract v7), the curate prompt browsing a subject first, the ops Topics tab filtering by subject, and the live library dropped and republished under it. Model routing moves to
GLM-5.3-Flash through the local Ollama cloud model with TokenHub as fallback;
the headless Sonnet arm is retired from the builder; the book-summary stage is
dropped; selective recovery becomes a batch stage over parser-flagged chunks.
