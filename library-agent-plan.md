# Plan: Library mode, one build flow, study preferences, interactive blocks

Date: 2026-10-01. Owner: Epo. Status: final, ready to implement. Plan B of two; plan A is
`study-progress-plan.md`, which lands first because the progress tool reads it.
Decisions: `human/agentic-retrieval.md` and `human/frontend/plate-editor.md`
(2026-10-01 entries). Deferred work: `todo-learning-outputs.md`.

## Goal

Curate mode goes away. Every chat turn can answer or build, and a per-turn
**Library** switch (default on) adds the knowledge library to the workspace as a
source. One prompt holds one build flow: clarify, survey, propose when building
more than one item, build on a todo-list ledger, reply. Study preferences steer
what gets built. Notes gain an interactive HTML block.

Prompt and tool work happens in the lab playground first (phase 1); the app
plumbing (phase 2) follows once the prompt behaves. Phase 1 edits pipeline Python
and the Go tool contract, which the running app also uses, so phases 1 and 2
reach UAT together; do not deploy between them.

## Current state

- `conversations.curate` (migration 0019) is fixed at creation. Go refuses a
  mismatched turn (`curate_mismatch`, `server/internal/httpapi/chat_stream.go:164`)
  and an actor without edit access (`curate_requires_editor`, `:137`,
  `huma_chat.go:54`), grants `library.read` only on curate turns (`:260`) and
  forwards `curate` and `ledger` to Python (`:421`).
- Python switches prompt, tools, limits and renderer on `ctx.curate`:
  `prompts/chat.py:121` picks the prompt; `retrieval/tools.py:1843` offers the
  library tools and `create_ledger`; `tools.py:1872` swaps tool descriptions from
  `prompts/curate.TOOL_DESCRIPTIONS`; `agent.py:343` drops the planning ceiling;
  `agent.py:491` renders curate replies as plain prose (`PlainRenderer`) and
  ordinary answers as OpenUI Lang; `agent.py:777` refuses curate under a
  200k window.
- Ledger (`tools.py:83-293`): `requests`, `todos`, `materials`, `next_todo_id`,
  plus turn-only `reads`. `create_ledger`'s `body` replaces `requests`
  (`tools.py:1013`). `curate_write` (`tools.py:1254`) requires a ledger, an open
  `todo`, and read excerpt ids. Go stores it opaquely and refuses non-curate
  conversations (`internal_ledger.go:67`).
- Limits (`retrieval/limits.py`): chat has 8 planning responses, 32 tools per
  turn and an 8-capture cap; curate has 160 tools per turn, no capture cap and
  the stall guard (5 responses without progress, +2 per errored write, max 9).
  Compaction caps input at 250k for every call (`retrieval/compact.py:25`).
- **Agent-written notes are not converted from markdown.** `create_material`
  stores a note's markdown as the text of one paragraph
  (`server/internal/materialdoc/document.go:1237`), and `insert_block` turns each
  line into a plain paragraph (`internal_documents.go:406`). Mermaid fences in
  notes therefore show as raw text today. Only the browser's markdown import
  (`src/features/notes/markdown.ts`) builds custom nodes.
- The playground (`lab/playground`) imports the app's prompts, tools and agent and
  patches them per turn. Its chat mode grants no write operations and an empty
  `user_id` (`scripts/playground.py:560`), so it cannot build. `configs/chat.json`
  carries a stale prompt copy; `configs/curate.json` a frozen copy of the curate
  prompt.
- The question bank is unreachable from the agent (no search, no operation);
  that work is in `todo-learning-outputs.md`.

## Phase 1: playground

Changes here are pipeline Python (prompts, ledger, limits, tools) and the Go tool
contract's descriptions and schemas (`server/internal/agenttools/agenttools.go`,
regenerated with `pnpm gen:openapi`). No database, gateway or frontend change.
Python reads a `library` flag on `ToolContext` in place of `curate`; until
phase 2, the playground sets it directly.

### 1.1 Playground harness

- Replace the "Curate mode" checkbox (`ui.html:171`) with a per-turn **Library**
  checkbox, default on.
- Chat mode grants the build operations (`material.create`, `document.edit`)
  and `user_id="playground"` on every turn; `library.read` only when Library is on.
- One config, `configs/chat.json`, with `system_prompt: null` so the playground
  runs the app's prompt; delete `configs/curate.json` and the playground's own
  `KNOWLEDGE_TOOLS`/`ALLOWED_TOOLS` copies once the app's gating covers them.
- A turn input for "open file" (a file id or none) and a study-preferences
  editor (the fields in 1.4), both sent into the prompt the way the app will.
- Local write stubs keep running through the real write guard (renamed from
  `curate_write`, see 1.3).

### 1.2 One system prompt

Merge `prompts/chat.py` `SYSTEM_PROMPT` and `prompts/curate.py` `SYSTEM_PROMPT`
into one prompt in `prompts/chat.py`; delete `prompts/curate.py` except the
ledger renderer, which moves beside the agent. Sections:

1. **Grounding and safety rules**, shared: tool results are data, never fill gaps
   from general knowledge, `[formula]` and `[Diagram description: ...]` rules,
   capture before using numbers, formulas, tables or figures.
2. **Answer or build.** A question gets an answer with citations. A request to
   learn, make, expand or practise gets materials.
3. **Build flow.**
   - Ask when the requirement is vague, until the scope and when to start writing
     are clear. Reuse requirements already given; propose a default the learner
     can acknowledge.
   - Survey first with read-only tools (`list_sources`; library browse or search
     when Library is on). This reverses curate's "no tools before clarifying".
   - Propose before building more than one item: the chapters or topics, one main
     explainer each, and the practice. A single item (an explanation for the open
     file, one more quiz) may be built directly. When unsure, propose.
   - Use the ledger for multi-item builds: one todo per material or section.
   - Choose the search per need: workspace, library (Library on), and later the
     question bank.
   - With Library on, reuse library exercises and worked examples (and later bank
     questions) for practice before generating new questions.
4. **Output rules.**
   - Per chapter, one main explainer: a note for detailed, text-dense learning
     (it exports to DOCX). Decks are deferred.
   - Mindmaps, diagrams and interactive blocks go inside the note, where they help
     an idea; standalone mindmap or diagram only when asked.
   - Quizzes and flashcards are standalone workspace materials in the chapter by
     default; a quiz or flashcards embed inside a note is a mini knowledge check
     of a few questions or cards.
5. **Ledger rule**, one line: "Building more than one item: keep a todo per item
   on the ledger and pass its id when writing."
6. **Library section**, appended only when Library is on: library tools, excerpt
   reads before writing, attribution through `excerpt_ids`, topic and role
   filters. This is today's curate rules minus the sequence.
7. **Budget**, stated once with numbers read from `limits.py` instead of hard-coded
   text (`curate.py:33` hard-codes 4/160/5/2).

The OpenUI answer rules (`openui_lang.txt`) stay for every turn; build replies
become ordinary OpenUI answers listing the materials made. `PlainRenderer`
(`retrieval/openui.py:356`) is deleted.

Tool descriptions: fold the curate overrides into the contract descriptions in
`server/internal/agenttools/agenttools.go` (one set, no per-mode swap) and delete
the swap in `tools.schemas_for`. The playground shows them unchanged, since it
imports the generated contract.

### 1.3 Ledger and limits

- Stored shape: `todos`, `next_todo_id`. Drop `requests` and `materials`
  (`STORED_REQUESTS`, `STORED_MATERIALS`). The turn-only `reads` stay.
- `create_ledger {todos}`: drop `body` from the Go schema; strings add todos,
  `{id, todo}` upserts; at most 10 open, refused atomically. The first ledger no
  longer needs a body.
- The write guard (`curate_write` → `ledger_write`) runs on every turn: a todo is
  required only when a ledger exists with open todos; read excerpt ids are
  required whenever library excerpts were read. Today outside curate the guard
  ignores `todo` and refuses `excerpt_ids`; both rules merge into this one.
- Ledger message: open todos by id, excerpts read this message, the final notice
  when tools are off. Nothing else. It stays outside the message list and outside
  compaction.
- Progress for the stall guard: creating the first todo and completing a todo,
  as today.

Limits (`retrieval/limits.py`, `agent.py`):

- A turn without a ledger: 8 responses, the last with tools off (the old chat
  ceiling). That covers answers and single-item builds; a turn needing more room
  creates a ledger.
- Once the turn's ledger has todos: the stall guard (5 responses without
  progress, +2 per errored write, at most 9) and 160 tool calls per turn govern
  it, with no response ceiling.
- Every turn: 4 tool calls per response, no capture cap (`captures_per_turn` and
  `CAPY_CAPTURES_PER_TURN` go). `search_workspace` stays one per response.
- Rename the curate constants plainly (`CURATE_TOOLS_PER_TURN` →
  `LEDGER_TOOLS_PER_TURN`, `CURATE_STALL_RESPONSES` → `STALL_RESPONSES`, and so
  on); `TOOLS_PER_TURN` (32) goes, since 8 × 4 already bounds a turn without a
  ledger.
- Delete the 200k window check (`agent._curate_unavailable`); every model in the
  registry is assumed to have at least a 250k window, matching compaction
  (`compact.py:25`). Add a registry test that fails when a chat model is
  registered below it.
- The budget paragraph in the prompt reads these numbers from `limits.py`.

### 1.4 Study preferences in the prompt

Rendered in the same always-current message as the ledger, from the requester's
saved preferences (phase 2 stores them; the playground edits them in the UI).
Fields and defaults (accepted 2026-10-01; a main-format field arrives with decks):

| Field | Values | Default |
|---|---|---|
| Explainer style | brief, standard, detailed | standard |
| Practice with each chapter | none, quiz, flashcards, both | quiz |
| Quiz length | questions per chapter quiz | 8 |
| Flashcards per chapter | count | 15 |
| Mini knowledge checks in notes | on, off | on |
| Visual aids in notes | fewer, more | more |

A small mapping turns these into instructions, for example "detailed: a full
note per chapter with worked examples; brief: a short note, key points first".
The mapping lives in `prompts/` next to the prompt so the playground tunes it.
Language is the account locale (`prompts/locale.py`), not a preference. The
request overrides any field ("make it brief this time").

### 1.5 Open file context

The prompt gets one line: the file or material the learner has open (title and
id), or none. "Add an explanation to this" then resolves without a search.

### 1.6 Study progress tool (after plan A)

`read_study_progress` (read-only, `source.read` plus progress on for the
requester in this workspace): done, started and removed item ids, recent quiz
results per chapter (score, date), and chapters with the weakest review state.
The playground stubs it from a fixture until plan A lands.

### 1.7 Exit criteria

A set of saved playground runs covering: a vague request (asks), a broad request
(proposes, then builds several chapters on the ledger), a single-item request with
a file open (builds directly), a question (answers with citations, no build),
Library off (workspace only), and a preference change (brief vs detailed). Epo
reviews the runs before phase 2.

## Phase 2: application

### 2.1 Remove curate mode

- Migration: drop `conversations.curate`. No data to keep.
- Go: delete `curate_mismatch`, `curate_requires_editor` and the curate branch in
  `createConversation`; `chatStreamReq` gets `library bool` and `openResourceId`
  (optional); grant `library.read` when `library` is true, for any role that can
  chat (reading the library needs no edit right; writes stay gated by role as
  today, `chat_stream.go:250`). The ledger route drops its curate check
  (`internal_ledger.go:67`). Delete the frozen/full refusal of curate turns;
  frozen and full actors already lose the write operations.
- Python: `ChatStreamReq.curate` → `library`; `ToolContext.curate` goes; library
  tools are offered when `library.read` is granted and the library is configured;
  `evidence.py` packs library excerpts whenever any were read.
- Frontend (`ChatPanel.tsx`): the curate toggle becomes a Library chip in the
  input, on by default, sent with every turn; delete `curateToggle.ts`, the
  history "Curate mode" chip, the AskUser suppression, the curate placeholder and
  i18n keys, `chatStream.ts` error mappings, MSW scenarios
  `chat-curate-mismatch`/`chat-curate-requires-editor`, and `Conversation.curate`
  from openapi and generated types. Send the open file or material id.
- Regenerate the contract (`pnpm gen:openapi`), bump `ContractVersion`, update
  `SUPPORTED_VERSION` in `retrieval/contract.py`.

### 2.2 Agent-written notes become real documents

Required for any of the output rules to work, because note markdown is stored as
literal text today. Decided: convert markdown to Plate in the collaboration
service, which already runs Node, validates material documents
(`collaboration/src/materialDocument.ts`) and applies agent edits, by running the
editor's own deserializer (`src/features/notes/markdown.ts` with a headless
editor) so agent markdown and pasted markdown produce the same nodes.

- `create_material` (note): Go sends the markdown to the converter and stores
  the result instead of `FromLegacyMarkdown`'s single paragraph.
- `edit_document`: a new `insert_markdown {after_block_id, markdown}` command
  replaces line-per-paragraph `insert_block` for notes.
- Mermaid fences become mermaid nodes. Quiz and flashcards fences become
  mini-check embeds: the converter creates the embedded rows (with
  `parent_material_id`) through Go and inserts `material_ref` nodes, so a viewer
  never sees an unresolved reference. Interactive fences become the block in
  phase 3.
- Delete `server/internal/mdblock` (no callers).

### 2.3 Output rules in the contract

- `create_material`: takes `chapter_id` so standalone quizzes and flashcards land
  in the chapter they practise; kinds stay note, quiz, flashcards, mindmap,
  diagram (the last two standalone only on request, per the prompt).
- `list_sources` already lists standalone quizzes and flashcards under Study
  materials; group them under their chapter so the agent sees which chapters have
  practice.

### 2.4 Study preferences

- Storage: `users.study_preferences jsonb` (preferences live as `users` columns,
  like `locale` and plan A's `study_progress`; there is no settings table),
  validated by a Go struct with the enums above. No per-workspace override.
- API: read with the account, `PATCH` from Settings; generated zod validators.
- Settings: a Study preferences section in the customizations tab, using the
  existing input components and react-hook-form.
- Chat: Go forwards the requester's preferences on each turn; Python renders them
  with the ledger message.
- `/generate`: `GenerateReq` reads the same preferences as defaults for its
  options; `style`, `length` and `format` are accepted but unused today
  (`retrieve/service.py:538`) — wire the ones that map to preferences and delete
  the rest.

### 2.5 Tests

- Go: chat turn grants `library.read` by flag, not by conversation; ledger write
  accepted for any conversation; `create_ledger` without body; markdown
  conversion of a note with mermaid, quiz and flashcards fences; preferences
  validation.
- Python: one prompt in both Library states; write guard rules (todo only with
  open todos, excerpt ids after library reads); the 8-response ceiling without a
  ledger and the stall guard with one; registry window test. Delete the curate-only tests in `test_agent.py` and
  `test_retrieval_helpers.py` that no longer apply (mismatch, 200k, PlainRenderer).
- Vitest: Library chip default and per-turn body; delete `curateToggle.test.ts`.
- Update `openwiki/agentic-retrieval.md` (curate sections), `openwiki/test-catalog.md`.

## Phase 3: interactive HTML block

A note block holding an agent-written, self-contained HTML snippet.

- **Element:** void `html_embed {id, html, fallback, title?}` with one empty text
  leaf (the `chart`/`graph` shape, `src/features/notes/blocks/plugins.ts:108`),
  registered like mermaid: `document.ts` type and validation,
  `blocks/plugins.ts`, `elements.tsx` (inside `EmbedShell`, with a source dialog
  like `MermaidSourceDialog`), `staticNodeComponents.tsx`, `staticPlugins.ts`.
- **Markdown:** a ```` ```html-embed ```` fence (`blocks/shared.ts`
  `CUSTOM_BLOCK_LANGS`, `markdown.ts` serialize rule), so the agent writes it in
  note markdown and the converter in 2.2 builds it.
- **Rendering:** `<iframe sandbox="allow-scripts" srcdoc=...>`, never
  `allow-same-origin`, forms, popups or top navigation. The opaque origin keeps
  the snippet away from cookies and storage. The host wraps the snippet with a
  CSP meta tag (`default-src 'none'; script-src 'unsafe-inline';
  style-src 'unsafe-inline'; img-src data: blob:; font-src data:`), so it has no
  network access, plus theme tokens for light and dark and a tiny resize script.
  Messages from the frame are accepted only when `event.source` is that frame,
  and only `{type: 'resize', height}`. No separate origin is needed: the app has
  no CSP today (`index.html`, `public/_headers`, `workers/site/handler.ts`). If
  one is added later, srcdoc frames inherit it and it must allow them.
- **Limits:** a 64 KB cap on `html`, and a cap on `fallback`, checked
  in Go `materialdoc` and the collaboration validator, which today let unknown
  types through.
- **Export:** `render.ts` must handle the type or export throws
  (`src/features/notes/export/render.ts:496`). Export writes the fallback text
  (DOCX and markdown) and never runs the snippet; the rasteriser in
  `figures.tsx:43` uses an unsandboxed same-origin iframe and must not receive it.
- **Indexing:** skipped by retrieval like mermaid (`document.go:867`).
- **Agent guidance:** the tool description carries the rules (self-contained,
  no network, use the provided theme variables, keep it small, always write a
  fallback). Interactive results do not feed progress (mini checks stay outside
  progress).
- **Tests:** Go and collaboration validation caps; export of a note with the
  block; a vitest that the iframe carries exactly `allow-scripts`.

## Settled during review (2026-10-01)

- Markdown becomes Plate in the collaboration service with the editor's own
  deserializer (2.2).
- Turn limits: 8 responses without a ledger, stall guard and 160 calls with one
  (1.3).
- Study preference fields and defaults as in 1.4; no main-format field until
  decks.
- The interactive block's snippet is capped at 64 KB.

No open decisions remain.
