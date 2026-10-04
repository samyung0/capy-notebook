# Agentic-loop playground

A local web page that runs the production chat agent (`pipeline.retrieval.agent`)
in-process against a real index, with the knobs that matter for retrieval quality
taken from a JSON config you edit and save in the browser. Every turn is recorded.

```sh
uv run --with pymupdf==1.28.2 python lab/playground/scripts/playground.py --target lab
# then open http://127.0.0.1:8765
```

Set `ALIBABA_API_KEY` in the shell first if a config uses `capture.mode = "ocr"`.
`RELACE_API_KEY` (Relace, which serves the GLM-5.3-Flash pin) is loaded from
the UAT worker or repository-root `.env.local` with the other provider keys,
so it needs no export.
The Claude desktop app's `.claude/launch.json`
carries `rag-playground-uat`, which starts this server against UAT on port
18765 with `uv` invoked by its full path. The server opens its own SSH tunnel
without `ssh -f`, which Windows OpenSSH ignores, and polls the forwards instead.

## Access from another device

`https://playground.capynotebook.com` routes through the dedicated
`capy-playground` Cloudflare Tunnel to this developer PC's `127.0.0.1:18765`.
The `Capy agentic playground` Access application allows only
`yungchinpang999@gmail.com`, using an emailed login code. Both the playground
and the tunnel must be running, and the PC must remain awake and online.
Neither process currently starts automatically after a reboot.

To restart on this Windows PC, run these commands in separate PowerShell
terminals, from the repository root:

```powershell
& "$env:USERPROFILE\.local\bin\uv.exe" run --project pipeline --with pymupdf==1.28.2 python lab/playground/scripts/playground.py --target uat --port 18765
& "$env:USERPROFILE\.local\bin\cloudflared.exe" tunnel --no-autoupdate run --token-file "$env:USERPROFILE\.cloudflared\capy-playground.token"
```

The tunnel token stays outside the repository with access limited to the
Windows user and SYSTEM. Keep Cloudflare Access attached to the entire hostname,
including `/api/*`. Quick Tunnels do not support the playground's SSE streaming.

## Targets

| Target | Index | How it is reached |
| --- | --- | --- |
| `lab` | Frozen September 9 evaluation database (`odl_eval`): 29 sources, workspaces `odl_eval_odl` (refined ODL with generated captions), `odl_eval_mineru`, `odl_eval_odl_nocaption` (same refined ODL chunks, no caption step; added 2026-09-12 by `odl_agentic_prepare.py nocaption` then `index --arms odl_nocaption`) and `odl_eval_odl_ocr` (the caption-free chunks plus RapidOCR lines on the eleven pages with no text layer, staged by `bench/parsers/scripts/experiment_odl_selective_ocr.py`, then `index --arms odl_ocr`) | ssh tunnel to the ingest host, loopback port 15435 |
| `uat` | The UAT Postgres (currently five workspaces, one file, no chunks) | ssh tunnel through the ingest host to the WireGuard address 10.77.0.3 |
| `local` | The dev compose stack on this PC (`deploy/docker-compose.yml`), `DATABASE_URL` from `deploy/.env` | no tunnel |

The server opens the tunnel itself (`CAPY_INGEST_SSH_KEY`, else the first of
`~/.ssh/id_ed25519_capy_ingest` and `~/.ssh/capy_ingest_159_195_61_195` that
exists), reads the UAT worker's provider and bucket credentials over ssh into
process memory, and points `DATABASE_URL` at the chosen target. Provider spend
lands on the UAT keys. One server process serves one target; run two on
different ports for both.

The tunnel also forwards 15433 to the shared knowledge library
(10.77.0.2:5433). `LIBRARY_DATABASE_URL`, `CAPY_LIBRARY_TAG_MIN_CONFIDENCE` and
the five `KNOWLEDGE_BASE_B2_*` values are lifted from the repository-root
`.env.local` before the pipeline imports; only when `.env.local` has no library
URL does the server fall back to the deployed one moved onto port 15433. Every
target reads the same live library; books carry their own versions.

Lab source PDFs come from `bench/rag/fixtures/local/2026-09-09-odl-agentic/pdfs`.
UAT PDFs are downloaded from the UAT bucket on first capture into `local/pdfs/uat`
(Office sources use their LibreOffice preview PDF, the coordinate space the chunk
regions refer to).

The lab dump predates the trash columns; `ALTER TABLE files ADD COLUMN trashed_at
timestamptz` was applied to the live lab database on 2026-09-12 so the current
store queries run. The frozen dump file is unchanged.

## What the playground writes

Nothing in either database. The `rag_search_events` telemetry write is disabled
for the turn. `list_sources` reads the selected workspace directly, using the
production listing format without a signed-in user or gateway. Database sources
and materials are read-only; materials created in the current run are editable.
Runs land in `local/runs/<id>/run.json` with the effective config,
the exact system prompt and offered tool schemas, every tool call with the text the model saw, every
provider call with token counts, captured images, citations and the answer.
A run also records the ledger twice: the turn as the model saw it
(`next_todo_id`, `todos` with the id the turn context showed and their done
state, plus the turn's own `progress` and `reads`), and under `stored` exactly
what the gateway would have persisted, the newest 10 open todos.
It records the incoming `ledger_in`, stall events and every material with its provenance books too;
the materials themselves are written as
`local/runs/<id>/materials/<id>.json`.
`local/` is git-ignored; `configs/` is committed so config changes are reviewable.

Each entry in the right-hand Materials panel opens a dialog with the saved note,
quiz questions/options/answer fields, or flashcards. The dialog also exposes the
original saved JSON and provenance. This works during a run and after restoring
one from history. Answer fields are shown as saved, without guessing whether a
legacy numeric answer is zero-based or one-based. Use Close or Escape to return.

## Config

Fields absent from a config take the defaults in `DEFAULT_CONFIG`
(`scripts/playground.py`). The interesting ones:

| Field | Meaning |
| --- | --- |
| `model` | A `model_configs` pin (`provider_slug`, `model_slug`, `version`, `thinking`). Add `adhoc: {…}` to pin a model the catalog lacks; the provider's platform key must exist |
| `model.transport` | Send this pin to another OpenAI-compatible endpoint: `{"url", "key_env", "wire_model", "body"}`. `body` picks the request builder (`zai`, `openai`, `deepseek`). `null` uses the production route |
| `answer.citations` | `as_is` (production numbering), `renumber` (markers rewritten to 1, 2, … in first-appearance order while streaming; the final list holds only the passages used) or `structured` (the answer is JSON: claims with the passages that ground each; the playground writes the prose and numbers) |
| `system_prompt` / `prompt_addon` | `null` keeps the production prompt; a string replaces it. The addon is appended either way |
| `tool_descriptions` | Map of tool names to replacement descriptions, for example `{"search_knowledge": "Find relevant excerpts."}`. Unspecified tools keep their production descriptions; `browse_knowledge` still receives the live subject catalog |
| `library` | The per-turn Library switch (default on): the shared library is a source and its tools are offered |
| `open_resource` | What the learner has open, `{"id", "kind", "title"}` or `null`; the turn context names it |
| `study_preferences` | The learner's saved preferences; missing fields take the defaults in `pipeline/prompts/preferences.py` |
| `study_progress` | `null` leaves `read_study_progress` unoffered; a dict is the fixture it returns, shaped like `/api/internal/study-progress` (`items`, `recentAttempts`, `weakChapters`) |
| `ledger` | Path to a stored ledger the turn continues: a previous `run.json`, or a bare ledger. `--ledger <path>` sets it for every config that does not carry its own |
| `tools` | `null` (default) offers what production offers for an editor; a list of tool names narrows it for an experiment. Limits are production's (`pipeline/retrieval/limits.py`) |
| `search` | `top_k`, `per_file_cap` |
| `capture.mode` | `pixels` attaches the JPEG to the conversation (needs a vision chat model); `ocr` sends it to Qwen3.5-OCR (`ocr_route` `docparse` or `chat`) and returns the transcript as a passage; `caption` asks the captioning model, question-aware when `question_aware` is true |
| `capture.require_seen_page` | Refuse captures of pages no retrieved passage has shown |
| `capture.citation` | `page` (default): a capture of a page that retrieved passages already cite adds no citation; the tool result names their numbers and the model cites those. `new`: every capture is its own citation with the rendered box as region |
| `capture.max_edge`, `capture.detail` | The density knobs. GLM, DeepSeek and Qwen price an image by the pixels sent (GLM: about width × height / 784 tokens, a 28-pixel patch grid), so the long edge and the model's `bbox` decide the cost; `detail` (`low`, `high`, `auto`) is passed through only for OpenAI, the one provider with a switch |
| `context.input_limit_tokens` | Force the agent's compaction threshold down (production uses the model's usable input limit, 250k at most) to exercise checkpoint folds and live compaction on short conversations; the summarizer's own fit check keeps the real limit |
| `quality.show` | Append `[extraction confidence …]` to passage headers from `local/quality/<target>-<workspace>.json`; `only_below` hides notes above a score |

In **Tool prompts**, choose a tool, edit its description, and click **Apply tool
prompt**. **Save** stores the overrides with the config. **Reset tool prompt**
restores the selected tool's production description. The tools array below the
editor shows the effective descriptions, catalog and unchanged argument schemas.
Prompt drafts survive background preview refreshes; apply them before running.
Loading a config or editing its JSON refreshes the editors from that config.

`capture_page(file_id, page, bbox?)` renders the page or a box on the 0-1000
page grid (top-left origin, the same space as chunk `regions`). In `pixels` mode
the image rides in a user message placed after the tool results of that step,
because chat-completions tool messages carry text only. Captures get a citation
with the rendered box as its region.

## Building

Every turn runs the production prompt and loop: it answers a question or builds
materials. The Library checkbox, the Open picker and the preference controls
write `library`, `open_resource` and `study_preferences` into the config, and
the turn context message shows them to the model. Library tools require the
header to show a configured library; a library that is down leaves the turn on
the workspace.

A turn without ledger todos gets 8 responses, the last with tools off. Once the
ledger has todos, 160 tool calls per turn and the stall guard govern it: five
responses without completing a todo turn tools off, and the turn reports
`stall` (or `tool_cap` when the call cap ended it). The page shows the ledger's
todos with their state and the turn's reads beside the runs list.

There is no gateway, so `create_material` and `edit_document` are handled in
process: a created material is written to `materials/<id>.json` under the run
with the provenance `library.provenance` resolved for its `excerpt_ids`, an edit
appends its commands to that file and merges its own books into the record by
book id the way Go does, and both return the receipt the gateway would have
produced. Both go through `tools.ledger_write`, the production write guard (a
todo while todos are open, excerpts read this turn or retained in full), and a
quiz goes through `server/cmd/quizcheck`, the app's own quiz validation, so a
saved quiz is one the app accepts. A note's fences are checked the way the
editor's import and the interactive block will take them (`check_note`):
quiz fences through `quizcheck`, flashcards with a front and back, and
`html-embed` with a fallback, under 64 KB and without network access. There is no gateway to store the ledger in
either, so `tools.store_ledger` is stubbed and `run.json` holds it. The page
carries the stored ledger into the next turn automatically. `--ledger` can also
seed a conversation from a saved run, starting from its `stored` ledger the way
the gateway hands one back: done todos gone, open todos under their existing ids.

`create_ledger` accepts strings to add new todos and `{"id": 0, "todo":
"Replacement text"}` to add or overwrite a todo by ID. Completed IDs are not
reused, unmentioned todos stay unchanged, and only the first changed plan in a
turn counts as progress. At most ten todos may be open.

`list_question_bank` and `read_question` read the question bank at
`CAPY_PLAYGROUND_BANK_URL`, by default a local restore on port 15499 of a dump
(see `bench/rag/scripts/bank_search.py` for the commands); the playground never
reads the live bank. A restore older than the newest bank migration needs it
applied first, pinned to the local container:
`cd server && BANK_OWNER_DATABASE_URL=postgresql://postgres:lab@127.0.0.1:15499/bank go run ./cmd/bank migrate`
(the 2026-10-03 dump lacks `questions.question_types`, and the bank tools fail
without it). They are offered with Library on and a configured library.
`copy_questions` (playground-only, `bank_copy.py`) goes with them: the model
names bank question ids and one destination (a new quiz, a quiz or note this
run made), and the questions are copied exactly with their bank sources
instead of being written out.

The library reads, `capture_knowledge_page` and compaction use the real
code path. `capture_knowledge_page` renders from the knowledge-base bucket into
the same capture cache, keyed by the book's `books/<sha256>.pdf` object key.

## Citation modes

Production assigns a number to every passage when a tool result comes back and
the model cites by those numbers, so an answer can read `[1][6]`. `renumber`
rewrites markers as they stream (a marker cut at a chunk boundary is held back
until it closes) and emits a final `citations` event with `final: true`, the
passages the answer used in their new order, and the retrieved-but-unused ones
under `unused`. `structured` adds a rule to the system prompt asking for
`{"answer": [{"text", "passages"}]}`, enforces `response_format: json_object`
only on calls that offer no tools (with tools offered, GLM under `json_object`
skipped the search and invented an answer), makes one repair call when the
answer does not parse, and renders the prose itself. `run.json` keeps the raw
model text as `answer_raw` and any repair output as `repair_raw`.

## Context, compaction and checkpoints

Every model call emits a `context` line: the provider-reported input tokens
(and cached reads), the production estimator's total against the limit the
compactor enforces, and a breakdown by part: system prompt, tool schemas,
memory (folded checkpoint), prior history, the query, this turn's assistant
steps, tool results (with their count) and attached images (count and patch
estimate). The estimator runs above the provider count by roughly a third on
these runs; both numbers are recorded per call in `run.json`.

Conversation turns carry message ids, so the agent's rolling checkpoint works
as in production: when the request would not fit, completed history is folded
into a memory message, a `checkpoint` event names the last folded message, and
the page drops those messages from the history it sends next time and passes
the checkpoint payload instead (what the Go gateway does). Live compaction
inside a turn folds history the same way; if the request still does not fit,
the turn's older tool exchanges fold into a turn note (`kind: turn_note`) and
the last two exchanges stay exact. Each summarizer call is shown as a
`compaction` card with its kind, the folded count, the memory size and the
text, and is kept under `compactions` in the run. Seen while testing: on a two-message
history the memory came back longer than the history it replaced (295 to 410
tokens for about 360), so a very small forced limit ends in
`context_too_large`; the summarizer prompt targets 4k to 10k tokens and is
built for long histories.

Follow-ups send the user/assistant history, each completed answer's
`toolEvidence`, the checkpoint and the stored ledger. Library turns retain `toolEvidence.libraryExcerpts`: exact bounded read results
for excerpt IDs used in successful material creation or editing. Unused reads
and refused writes add no retained evidence. Paginated reads keep the pages the
model actually received; repeated use replays each page only once.

Before replay, read-only library queries check that each saved result still
matches. The full text enters normal history and counts as already read for
material writes while it remains in the model request. Compaction can remove
that permission: an ID or summary alone requires a new `read_knowledge` call.
The application and playground use the same retention, revalidation and write
guards. Source text is stored in private message evidence; it is not part of
the ledger. New successful writes retain their used excerpt reads. Opening a saved run
restores its prior history and current exchange, retained evidence, checkpoint
and ledger without changing the selected config. Clear conversation resets
this state. A page reload starts a new conversation; open a saved run to resume.

## Extraction confidence

`chunk_quality.py` scores every chunk of one workspace offline, parser-agnostic:

```sh
uv run --with pymupdf==1.28.2 python lab/playground/scripts/chunk_quality.py --target lab --workspace odl_eval_odl
```

Per chunk it measures how much of the chunk's text the cited pages' text layer
contains (words for spaced scripts, characters for CJK), whether those pages have
a text layer at all, whether pipe-table rows have consistent column counts, and
how much of each page's text layer the index carries at all. Generated captions
score at most 0.5. It reads the source PDF and the chunks; it changes no rows.
Limits: it cannot see reading-order or cell-association errors when every word is
present, and an OCR text layer counts as a text layer.

## Checks

```sh
uv run --with pymupdf==1.28.2 python lab/playground/scripts/capture.py
uv run python lab/playground/scripts/chunk_quality.py --check
uv run python lab/playground/scripts/playground.py --check
node lab/playground/scripts/check_ui.mjs
```

First observations are in
[`../reports/2026-09-12-capture-page-playground.md`](../reports/2026-09-12-capture-page-playground.md).

Chat turns require thinking to be enabled. The turn endpoint rejects `instant` before opening a stream; the production agent also enforces this policy. Protocol markup leaked into response text ends the turn with `response_flagged`.

### Decks

`create_deck` and `write_slide` exist only here until decks land in the app
(`todo-learning.md`, 2.6). They follow ppt-master's Quick route: `create_deck`
takes an outline of titles and briefs and returns the style (`deck-styles/`,
default `editorial`) with its reference slides; `write_slide` takes one slide
as SVG, which ppt-master's checker must pass (text inside its module's
bounds, no overlapping modules), and once every slide is written the deck is
exported with ppt-master's exporter to `materials/<id>.pptx`, closed by a
Sources slide from its provenance. Figures are this turn's bbox captures,
referenced as `../images/p<page>.jpg`. ppt-master is cloned on first use into
`local/ppt-master` at the commit pinned in `deck.py`, and its scripts run
under `uv` with their own dependencies. `DECKS.md` is the adoption guide:
how ppt-master works, what we use, and how to add a style.

The Decks checkbox writes `decks.offer`, and Main writes `decks.main_format`
(`note`, `deck` or `auto`), which reaches the model through `deck.ADDON` in the
system prompt rather than the study preferences, since production has no decks
yet. Mocks: `artifacts/2026-10-04-deck-layouts.html`.

When the agent withholds a response for carrying tool-call markup (reported as
"Response flagged due to safety concern"), `run.json` keeps the text under that
provider call's `flagged_text`.

### Acceptance (todo-learning.md, 1.9)

`configs/acceptance-*.json` are the scenarios for the end-to-end prompt tuning,
each on `chat.json`'s target and workspace with its own `question` and an
`expect` line saying what a good run does: a vague request (asks), a broad one
(proposes, then builds on the ledger), the open file (pick it with Open first),
a question (answers, builds nothing), Library off, brief and detailed
explainers, question-bank reuse, a deck, and a note with every fence. Load one,
run it, and save the run; a prompt change is judged against the saved runs.
