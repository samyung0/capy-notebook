# Knowledge base plan

Status on 2026-09-16: proposal. Nothing is implemented and no book has been ingested. This file consolidates the two research reports, the outside review, and Epo's decisions from the 2026-09-16 discussion. The decisions themselves are recorded in `human/agentic-retrieval.md`; this is the readable summary.

## Goal

A user in their own workspace says "I want to learn cell mitosis". With curate mode on, the chat agent reads a shared library of pre-ingested open textbooks and creates a small set of materials in the user's workspace: a note, a quiz, flashcards, maybe a study plan. Like NotebookLM, except the sources come from a library we control and have inspected.

## Decided (Epo, 2026-09-16)

| Decision | Consequence |
| --- | --- |
| Library scope is open textbooks, undergraduate and below, English. No region or exam targeting. | Book selection is by subject coverage and licence, nothing else. |
| No live external retrieval at question time. Everything is pre-ingested. | The Wikipedia, Commons, Openverse and web-search sections of the strategy report are dropped. Latency and offline goals are untouched. |
| Curate mode is a user toggle on the chat agent. On: library read tools plus material creation into the user's workspace, and the generate tool lives here. Off: only the workspace's own files. | The library is never a workspace scope. Citations or attribution attach after materials exist in the user's workspace. |
| The library embedding pin is fixed and independent of workspace pins. | A query is embedded once per index searched. Re-embedding the library is a rebuild into a new index followed by a swap. |
| Ingest volume and speed are not a constraint. | 600 pages parse in about 2 minutes on 4 CPU / 16 GB. Rented machines are fine. |
| Attribution is a visible footer on every curated material, one line per source book. | Stored as a provenance column on the material and rendered by the frontend, outside the editable document, so it cannot be deleted. If any source is ShareAlike, the footer also states the material's own licence. |
| The library has its own tool family (`search_knowledge`, `read_knowledge`, `capture_knowledge_page`), separate from `search_workspace`, and several calls are allowed per model response. | The one-search-per-response rule stays for `search_workspace` only. |
| The library embeds with Qwen3-Embedding-4B, the current workspace default. | One query embedding serves both indexes while the pins coincide. Library ingest embeds in batch; DeepInfra latency only matters at question time. |
| Postgres for records and vectors, B2 for PDFs, as today. | Tens of GB for about 1,000 books. |

Planned, not yet decided: Qwen3.8-Flash on Alibaba Beijing with batch pricing for ingest-time model calls.

## What already exists and gets reused

- Parser and ingest: OpenDataLoader parse with page and bbox per block, heading-aware 400-token chunks, hybrid search (pgvector halfvec 2560 plus Postgres lexical, RRF), per-file cap of 4.
- `capture_page` renders a page or bbox from the source PDF at question time. Figures need no separate image store for the pilot.
- Chat tools with one contract across Python, Go and the frontend: `search_workspace`, `list_sources`, `describe_documents`, `read_document`, `capture_page`, `create_material` (quiz, flashcards, mindmap, diagram, note), plus inspect, edit, trash and restore.
- The fixed Generate workflow at `/generate`, outside the agent loop.
- The ops app under `ops/` with operators, role tokens, audit events, and pages for overview, health, ingest host, registry, costs, users, reconciliation and audit.
- Public workspaces readable by any signed-in user, with chat.
- The playground under `bench/rag/playground` running the production agent against the lab or UAT index.

## Design as it stands

### Library storage

The library is a system-owned workspace (kind `library`) in the existing files, chunk and vector tables with a fixed pin. It is never listed to users; only curate-mode tools read it. Library-specific tables sit beside it:

| Table | Holds |
| --- | --- |
| `library_books` | title, authors, edition, source URL, licence, attribution text, PDF blob, sha, status, published version |
| `library_excerpts` | book, section path, page range, chunk ids, teaching role (introduction, formal, worked example, exercise, summary), figures |
| `library_figures` | excerpt, page, bbox, original caption, credit, excluded flag |
| `library_topics` | id, label, aliases, scope note, broader and related ids, status (proposed, active, merged into) |
| `library_topic_assignments` | excerpt, topic, origin (model or operator), confidence, batch job |
| `library_overrides` | excerpt, topic, add / remove / confirm, operator, reason, time. Applied last on every rerun |
| `library_relations` | excerpt pair, kind (exact, near copy, paraphrase, alternative, conflict), evidence spans |
| `library_review_items` | kind, payload, open / accepted / rejected, operator |
| `library_batch_jobs` | provider job id, stage, books, status, result path |

### Book lifecycle

admitted (PDF plus licence record) → parsed → indexed → tagged → in review → published → retired.

Only published books are searchable. Publishing a new edition retires the old one. Material provenance keeps pointing at the edition that was used.

### Ingest stages new to the library

1. Excerpt building from the parser's heading tree. A section keeps its equations, worked example and figures together. Search chunks point back to their excerpt.
2. Role and topic assignment. One model call per excerpt with a bounded candidate topic list derived from tables of contents. A new topic is proposed only when nothing fits. Uncertain assignments become review items.
3. Relations. Hash, then MinHash, then embedding neighbourhood nominate pairs. A model call classifies only nominated pairs and returns evidence spans. Uncertain pairs stay separate.
4. Stages 2 and 3 run as batch jobs (asynchronous, collected later). Parse, chunk and embed stay synchronous as today.

Cost with Qwen3.8-Flash on Beijing (checked 2026-09-16): 0.113 USD input and 0.382 USD output per million tokens, 50% off in batch. A 600-page book passes under one million tokens through stages 2 and 3, so roughly 0.05 to 0.10 USD per book.

### Curate mode in the chat agent

- Toggle per chat. Off is today's behaviour. On adds `search_knowledge`, `read_knowledge` and `capture_knowledge_page`, and keeps `create_material`. Knowledge tools resolve to the library index, never to a workspace scope, and may be called several times in one model response.
- Coherence rule: one primary excerpt per material section. Another book's excerpt fills a named gap only after checking terminology and notation. A worked example is never split.
- Provenance: `create_material` takes an optional list of library excerpt ids. Go persists it as material provenance and renders a footer from it: one line per book (title, authors, edition, licence, URL), an "adapted from" notice, and the material's own licence line when any source is ShareAlike. Mixed CC BY and CC BY-SA sources make the material CC BY-SA. The footer is a column on the material, rendered by the frontend outside the editable document, so it cannot be deleted.
- No citations. Curate mode ignores the final answer's passages server-side. The reply is the list of created materials with their receipts. Under the existing retention rule, library evidence is then dropped from conversation history after the turn; provenance on the material is the durable record.
- Budget (decided: no per-turn count and no planning-response ceiling in curate mode, 4 knowledge calls per response, 200k window minimum; a stall guard ends the turn after a few consecutive responses that change nothing in the ledger, and the credit guard bounds cost): live compaction now folds the current turn (decision 2026-09-16), keeping the query, one turn note of at most 12,000 tokens and the last two tool exchanges exact. That bounds the live chain, so the per-turn count of 16 can go in curate mode. Two limits still matter: the per-response count, because the fold drops whole exchanges and cannot split one oversized exchange (proposal: 4 knowledge calls per response, matching the parallel-execution limit, so one exchange is at most about 32k tokens); and a planning-response ceiling as a runaway guard rather than a context guard (proposal: raise from 8, do not remove; credit exhaustion already ends a turn gracefully).
- Ordering rule for curate (prompt pattern, no code): the response that writes a material comes within two responses of the reads it depends on. Per section: search, read, write. Create the note after the first section and grow it with `edit_document` per section rather than creating one large note at the end. Materials that span sections (quiz, flashcards) re-read the excerpts they need in one response, up to the per-response cap, and create in the next; the turn note keeps excerpt ids and what each supports, so the model knows what to re-read. Reads are database fetches, so re-reading is cheaper than raising `TURN_KEEP_EXCHANGES` for the whole turn.
- Measured (2026-09-16, mocked, see `bench/rag/reports/2026-09-16-turn-fold-capacity.md`): with a 200k window the fold never fails through 96 sections; the turn note saturates at about 46 sections and silently drops its oldest lines; captures accumulate as a standing charge. Models below 200k are out of scope for curate mode.
- Progress ledger (decided): an event log the loop derives from tool events, never compacted, riding outside the messages like captures: the request, materials created or appended (id, kind, title, size such as a running question count), excerpts read (id, section title, the material that used them). No declared sections or plan; the model compares the log against the request to decide what is left. Roughly 30 tokens per entry. The note ceiling stays at 12k.
- Captures (decided and implemented 2026-09-16, both modes): a capture lives as long as its exchange is kept verbatim and is dropped when that exchange folds; the note keeps the numbers read from it in text.

### Figures

Source PDF plus page, bbox, original caption and credit, rendered on demand through the existing capture path. A separate asset store for crops waits until materials embed images or exports need them. No generated figure descriptions: textbook captions are author-written and specific, and the excerpt link already carries the sentence that refers to the figure. Revisit only if the pilot shows retrieval failures on figures whose caption is a bare number.

### Operator control: a Library section in the ops app

| Page | What an operator does there |
| --- | --- |
| Books | See lifecycle status, licence, edition, counts. Admit, reparse, re-tag, publish, retire. |
| Batch jobs | See stage, status, token usage. Collect results. |
| Topics | Rename, add alias, edit scope note, merge (leaves a redirect), split, deactivate. |
| Review queue | Accept or reject with a reason. Accepting a new topic creates it. Accepting an assignment writes an override. |
| Excerpt browser | Browse by book or topic. See role, topics, figures (rendered from the PDF), relations. Override inline. |
| Try search | Run the library search exactly as curate mode would and read what comes back. |

Every mutation lands in `operator_audit_events`. Reruns replace model-origin rows and never touch override rows. The pilot runs without this UI, using SQL and the playground. Per `AGENTS.local.md`, new UI components start as static mocks.

## Pilot

1. Three books in one subject: two overlapping, one at a different level. Clean CC BY or CC BY-SA at edition level. OpenStax forks flagged.
2. Ingest into a library workspace on the lab, not on the shared Netcup host during user hours.
3. 20 to 30 requests shaped like "I want to learn X", a third held out from catalog building. Score whether the right excerpt and figure were retrieved, whether the produced materials hold together (consistent definitions, no unexplained notation, figure matches text), and whether attribution is present.
4. Arm A is existing hybrid search. Arm B adds role and topic tags. Duplicate-aware selection is skipped unless A shows repetition.
5. Only if B wins: build the library tables, curate-mode tools and ops pages.

## Open items needing a decision

None. Next step is the pilot.

Assumption to check when building: appending a batch of questions to an existing quiz through `edit_document`, so a 200-question quiz is built in batches rather than one create call.

## References

- `bench/rag/reports/2026-09-15-external-knowledge-strategy.md`
- `bench/rag/reports/2026-09-15-topic-knowledge-base.md`
- `bench/rag/reports/2026-09-15-external-search.md`
- `bench/rag/reports/2026-09-16-turn-fold-capacity.md`
- `knowledge-base-review.md`
- `human/agentic-retrieval.md`
- `openwiki/agentic-retrieval.md`
