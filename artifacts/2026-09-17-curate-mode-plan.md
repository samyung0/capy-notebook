# Curate mode, ops Library section, playground: implementation plan

Date: 2026-09-17. Owner: Epo. This plan turns recorded decisions into code.
Decisions are in `human/agentic-retrieval.md` (curate mode 2026-09-16, library
retrieval 2026-09-17, read-only ops Library 2026-09-17, no backward
compatibility 2026-09-17, per-book versions 2026-09-17). Where this plan
chooses among readings of a decision, the choice is marked **assumption** and
listed at the end; Epo confirmed A1-A3 on 2026-09-17. The reviewer checks the
implementation against both this plan and the decision catalog and reports to
a file, never fixes.

Rules for implementers: read `AGENTS.md`, the `human` catalog for
`agentic-retrieval` and `deployment-runbook`, and `openwiki/agentic-retrieval.md`
first. Follow `ponytail` (smallest working change, no scaffolding). No
backward-compatibility logic anywhere: no legacy field mapping, no compat for
older contract versions, plain migrations. Do not spawn subagents. Do not
edit `human/`; report decisions you need in your final message instead.

## What existed at the start

- Library database on the ingest host with the first pilot corpus; reader
  module `pipeline/pipeline/retrieval/library.py` (`search(query, topics,
  roles)`, `browse(topic, page)`, `catalog`, `LIBRARY_SCHEMA`), config
  `LIBRARY_DATABASE_URL`, `CAPY_LIBRARY_TAG_MIN_CONFIDENCE`, tests in
  `pipeline/tests/test_library.py`.
- Agent tool contract: `server/internal/agenttools/agenttools.go`
  (`ContractVersion`, operations table, `Definitions()`), exported by
  `pnpm gen:openapi` to `pipeline/pipeline/generated/agent_tools.json`, pinned
  by `pipeline/pipeline/retrieval/contract.py` (`SUPPORTED_VERSION`).
- Chat stream: raw chi handler `server/internal/httpapi/chat_stream.go`;
  pipeline request model `pipeline/pipeline/retrieve/service.py`; agent loop
  `pipeline/pipeline/retrieval/agent.py`; tools `retrieval/tools.py`; limits
  `retrieval/limits.py`; prompts `prompts/chat.py`; compaction `retrieval/compact.py`.
- Frontend chat: `src/api/chatStream.ts`, `src/features/workspace/useChatStream.ts`,
  `ChatPanel.tsx`, i18n `messages/en.json` and `messages/zh.json`, generated
  types re-exported through `src/api/types.ts`.
- Conversations had no mode column; materials had no provenance column.
- Ops: routes `server/internal/ops/http.go`, `ReadStore` with secondary pools,
  pools opened in `server/cmd/ops/main.go`, permissions from `ops_permissions`
  (`PermReadAll`); frontend `ops/src` with hand-written Zod in `api.ts`.
- Playground: `bench/rag/playground/scripts/playground.py` (FastAPI, runs the
  real agent with monkey patches, config JSON, `run.json`), `common.py`
  (targets `lab`/`uat`, SSH tunnel), `ui.html`.

## Phase 0: contract and gateway

1. `agenttools.go`: operation `library.read` (not role-derived); tools
   `search_knowledge {query, topics?, roles?}` (`UsesEmbedding`),
   `browse_knowledge {topic, page?}`, `read_knowledge {excerpt_id, start?}`,
   all `Concurrency: read`, `RequiredOperations: [library.read]`, `Retention:
   none` (curate ignores citations; library evidence is dropped from history
   after the turn; provenance on the material is the durable record);
   `create_material` gains optional `excerpt_ids` (max 32); `ContractVersion
   = 5` and `SUPPORTED_VERSION = 5`; `pnpm gen:api:full`; docs updated.
2. Conversation mode (**assumption A1**, confirmed: mode is fixed per chat at
   creation because curate turns carry no citations and drop library
   evidence). Migration `0019_conversation_curate.sql` adds
   `conversations.curate boolean NOT NULL DEFAULT false`; store and API models
   expose it; the stream request carries `curate` used only when a new
   conversation is created; a mismatching flag on an existing conversation is
   400 `curate_mismatch`; operations are the role's plus `library.read` when
   the conversation is curate; a non-editor is refused `curate_requires_editor`
   on both create and stream (decided after implementation).
3. Frontend: `ChatStreamBody.curate`, `send(text, curate)`, a header toggle
   enabled only while the chat has no messages, history badge, i18n in both
   locales, MSW accepts the field, generated `Conversation` type re-exported.

## Phase 1: pipeline curate loop

1. `ChatStreamReq.curate`, `ToolContext.curate`; at turn start curate
   requires `library.enabled()` and a model window of at least 200,000
   tokens, else `model_unavailable` with a logged reason.
2. Tools: handlers for the three library tools over `library.search/browse`
   and `library.read_excerpt(excerpt_id, start)` (chunks in order with a
   next-start marker); unknown topics or roles refuse `invalid_input` naming
   the catalog; rendering bounded by `limit_tool_result` (search: one block
   per excerpt with id, book, section path, pages, roles, topics, synopsis,
   hit chunk, figure ids, or the available-roles counts when empty; browse:
   counts by role and book then the page; read: header then chunk texts
   with a next-start). `_offered`: library tools need `ctx.curate` and
   `library.enabled()`; workspace read tools stay offered (**assumption A2**,
   confirmed). `schemas_for` appends the topic catalog to the two search
   tools' descriptions once per turn. `create_material` resolves
   `excerpt_ids` through `library.provenance` into a provenance record sent
   to Go; unknown ids refuse.
3. Limits and loop: curate has `KNOWLEDGE_TOOLS_PER_RESPONSE = 4`, no
   per-turn tool count, no planning ceiling; a progress ledger on the context
   (request; materials created or appended with id, kind, title, size;
   excerpts read with id and section, linked to the material that used them)
   rendered as one message right after the query on every call, never in
   history, never compacted; stall guard `CURATE_STALL_RESPONSES = 3`
   (**assumption A3**, confirmed); final answer plain prose, no citations
   event, no persisted citation list; live compaction unchanged.
4. Prompt `prompts/curate.py`: plan roles per request, map learner words to
   catalog topics, browse then search with topics and roles, read before
   writing, one primary excerpt per section, one book for notation, write
   within two responses of the reads, create the note after the first section
   and grow it with `edit_document`, quiz and flashcards re-read then create,
   always pass `excerpt_ids`, refuse honestly, reply with the materials list.
5. Tests per area.

## Phase 2: material provenance and attribution footer

`0020_material_provenance.sql` adds `materials.provenance jsonb` with books
(id, title, authors, edition, licence, licence url, source url, version,
excerpt ids) and the material licence: null unless a source is ShareAlike;
one ShareAlike licence string becomes the material licence; two distinct
ShareAlike strings refuse `lifecycle_rejected` (decided after
implementation). Immutable after creation; copied by clone paths. Exposed on
the API; `MaterialAttributionFooter` renders outside the editable document
with one line per book (title, authors, edition, version, licence link,
source URL), an "adapted from" notice, and the material licence line.

## Phase 3: ops Library section, read-only

`OPS_LIBRARY_DATABASE_URL` (optional, no role validation), routes under
`/api/ops/library` gated by `PermReadAll`, bounded queries, 404
`library_unconfigured` when unset; books with version history and receipts,
topics with retrievable/verified/total counts by role (retrievable applies
the 0.8 floor), excerpt list with filters and paging of 50, excerpt detail
with tags, chunks and figures, model runs, per-book JSON export with a
sha256 header (optional version); test fixture
`server/internal/ops/testdata/library_schema.sql` byte-identical to
`LIBRARY_SCHEMA` (parity test); ops page with tabs, filters, detail drawer,
export; env manifest and compose entries; no mutations.

## Phase 4: playground

`common.py`: configurable SSH key, tunnel forwards on 15432/15433/15435,
`LIBRARY_*` and `KNOWLEDGE_BASE_B2_*` lifted from `.env.local` before the
pipeline import, a `local` target. `playground.py`: `curate` config running
the real loop with `document.edit` granted, `create_material` and
`edit_document` writing JSON files under the run directory, widened
allow-list, `run.json` with ledger, stall events, materials, provenance,
captures; selector event loop on Windows. `ui.html` curate switch, ledger and
materials panels. `configs/curate-statistics.json`.

## Phase 5: library sources in B2 and `capture_knowledge_page`

Dedicated private bucket `capy-notebook-knowledge-base` (endpoint
`https://s3.eu-central-003.backblazeb2.com`, region `eu-central-003`), PDFs
as `books/<sha256>.pdf`, env `KNOWLEDGE_BASE_B2_{ENDPOINT,REGION,BUCKET,KEY_ID,APP_KEY}`
all-or-none; blobstore client factory and `download_file` parameterized by
bucket and client with a `library_download_file` wrapper; `object_key` on
the book version, recorded only after `head_object`; contract tool
`capture_knowledge_page {excerpt_id, page, bbox?}` refused outside the
excerpt's pages or its figures' pages, per-turn capture cap, no citation,
JPEG attached like `capture_page`, cache keyed by object key; curate prompt
capture rule; playground records captures.

## Phase 6: per-book versions, one live library

Decided 2026-09-17, superseding dataset versions and environment pins. One
workspace row `library`; one file per book; `library_books` keyed by id with
current `content_id` and `version`; `library_book_versions` (`book_id`,
`version`, `content_id`, `status` current|retained|retired, `source_run`,
`corpus_identity`, `parser_release`, `chunker_version`, `object_key`,
`descriptor`, `summary`, `note`, `published_at`); excerpts, figures and
model runs keyed by `content_id`; `library_topics` library-wide;
`rag_file_contents` points each book at current content and every read path
filters through it. Loader: `schema`, `publish --run [--book]` (new content
id per version, ids stamped `_v<n>`, upsert book, version row current,
previous retained, pointer swap, refuse an unchanged corpus identity,
object key after head_object), `rollback`, `retire`, `status`, `check`.
Reader: constant workspace, no pin environment. Ops: per-book version
history instead of a version picker. Env manifest and examples drop the pin.

## Verification

`pnpm test:go`, `pnpm test:pipeline`, ops tests and typecheck, frontend
tests, `pnpm fmt`, `pnpm fix`, `pnpm fmt:go`, `pnpm fmt:py`, `pnpm gen:api:full`
clean; the retrieval eval unchanged (library arm 105/105, five excerpts for
21 of 22); one real curate turn through the playground against the live
library; ops tests against the seeded fixture; test-catalog rows for every new
test. Live runs of the final shape (2026-09-17, after fix round 4): the loader
dropped the live library, recreated the schema and republished all three books
(86 s, identical counts to the first publish; an unchanged republish is refused
as "already holds this corpus identity"); playground run
`20260917-220250-b99d8c` (GLM-5.3-Flash, UAT target, live library) browsed,
created a three-todo ledger, read four excerpts, captured page 435 of AHSS from
the real bucket (252 KB JPEG), had a write refused for citing an unread excerpt,
read it, and then hit the stall guard at four barren responses with no material
written, its final answer still trying to write (fixed the same day: the final
ledger message now carries `FINAL_NOTICE`); follow-up run `20260917-220748-2cc4af`
started from that run's stored ledger, re-planned three duplicate todos instead
of completing the open ones, and wrote all three materials (note, worked example
on Figure 5.3, five-question quiz) with AHSS CC BY-SA 3.0 provenance, no stall,
8 provider calls, 120k input tokens, 2 minutes.

## Assumptions and open items

- A1 mode fixed per chat at creation; A2 workspace read tools stay in curate
  mode; A3 stall guard at three responses. All confirmed by Epo. A3 was
  reopened in fix round 1: four responses, counted against completed todos.
- Ops "try search" omitted: the ops service has no embedding path; the
  playground covers search testing.
- Relations, overrides, review-queue mutations: out of scope (read-only).
- Production stays library-less until `LIBRARY_DATABASE_URL` is set.

## Fix round 1 (2026-09-17, after the first Opus reviews)

Epo's decisions are recorded in `human/agentic-retrieval.md` (lines 72, 78, 80, 81,
105 reworded; four new 2026-09-17 lines at the end). Contract v6 adds
`create_ledger {body, todos}`, `todo` on `create_material` and `edit_document`, and
`excerpt_ids` on `edit_document`. The two implementer briefs are the fix
specification: `fix-go-frontend.md` and `fix-pipeline-bench.md` in the session
scratchpad (`C:\Users\yungc\AppData\Local\Temp\claude\C--WEB-capy-notebook\a66c0722-5dce-445f-b006-c16636280608\scratchpad`).
In short: ledger tool with todos and a stall guard at four responses without a
completed todo, no response ceiling, no capture cap in curate; read-before-write
enforced against the ledger; licence family rule (newest same-family version, refuse
mixed families); provenance appendable through edits, on files too, returned on
every file and material response except the public workspace summary; curate prompt
sequence and tool description overrides under `pipeline/pipeline/prompts/`; every
routine reviewer finding.

## Fix round 2 (2026-09-17, after the second reviews)

Decision 78 was reshaped: the ledger belongs to the conversation, not the turn.
It lives in `conversations.ledger` jsonb, rides in on the stream request beside
`curate`, and the pipeline writes it back through
`POST /api/internal/conversations/ledger` at turn end, on every exit path,
including the stall exit and the error returns. Each user message may call
`create_ledger` once — the call appends that message's request and its todos —
and a second call in the same turn is refused instead of replacing anything, so
the re-plan-and-rewrite loop of round 1 has no way back. `todo` is required on a
curate write to a material and refused when it is out of range or already done,
which makes every real write progress and lets the stall guard measure work
rather than tool traffic; a turn the guard ends reports its own stop reason,
`curate_stall`. None of the curate write rules reach an `edit_document` on the
user's own source file: it carries no todo, no excerpt ids and no provenance,
because Go refuses a source edit that does. An empty topic catalog refuses the
turn as `model_unavailable` rather than spending the stall budget discovering
that nothing is published.

## Fix round 3 (2026-09-17, after the third reviews)

The reviews found the ledger unbounded (`review3-pipeline-bench.md` R1): past
64 KiB the gateway refuses every write-back, the conversation freezes on a stale
snapshot, and the model rewrites the same materials each turn. Decision 78 now
bounds what is stored — open todos, the last 50 materials, the last 5 requests —
and the dropped done todos mean the kept ones are re-indexed from 0 on the way
out, so the rendered ledger states that its numbering is the one to use and the
write-tool descriptions say the same. A stored ledger Python cannot parse is
logged with the conversation id and the turn starts empty instead of aborting
the SSE body on every attempt (R3), and the `ToolContext` is built inside the
stream's error handling. An empty curate response is one no-progress response
and the loop continues, which makes `planning_cap` unreachable in curate (R2).
Two refusals gained a next move: every-todo-done says to reply with the
materials list and leave more work to the learner's next message (R4), and a
source-file edit carrying a `todo` is refused rather than silently ignoring it
(R6). R5 (two concurrent turns racing on the ledger) is answered on the Go side
by refusing a write whose assistant message is not the conversation's latest.

## Fix round 4 (2026-09-17, final)

Decision 78 was extended once more and this round closes the sequence: the
remaining findings were routine, so no review follows (`human/agentic-retrieval.md`
line 117). Every todo now carries an id from a per-conversation counter
(`next_todo_id`), assigned when `create_ledger` appends it and never reused or
renumbered, so the number the model wrote down in one message still names that
todo in the next one — round 3's re-indexing let a remembered number land on a
different todo, marking the wrong line done and re-creating the material a turn
later (`review4-pipeline-bench.md` F2). The rendered ledger shows the id, the
write tools take it, a material records the id it closed, and the stored shape
is `{requests, next_todo_id, todos[{id, text}], materials[…]}`: stored todos are
open by definition, so `done` and `materialId` are gone from the row. Open todos
are also bounded now — the newest 24 (F1) — which was the one array that could
still grow a conversation past the gateway's 64 KiB. `Ledger.from_stored` logs
the shapes it used to coerce (an object where an array belongs, an entry that is
not an object, a todo with no id, a counter behind a stored id) and starts the
turn empty instead (F6). Two stall behaviours gained tests and one changed: five
consecutive empty responses end the turn on the guard, and a credit-exhausted
terminal call with no text now reports `planning_cap`, the same as outside
curate, because labelling a billing cutoff `curate_stall` made the guard's own
counts unreadable (F3, F4). The playground's curate checkbox offers
`capture_knowledge_page`, which its own help had always listed (F7).

Still outstanding, as decision 117 sets out: the two live runs — a loader
publish against the live library and a playground curate turn with a real-bucket
page capture — and the loader publish transaction's missing test.
