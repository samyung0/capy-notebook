# Local knowledge-base builder: plan

Date: 2026-09-19. Owner: Epo. Status: approved 2026-09-19; implementation in progress.
Decisions are recorded in `human/agentic-retrieval.md` (the 2026-09-19 lines at
the end, plus the 2026-09-16/17 library, licence and quality lines). The fixture
`lab/knowledge/subjects.json` (areas and subjects) is
written and is the first artifact to review. Implementers read `AGENTS.md`, the
`human` catalog for `agentic-retrieval` and `deployment-runbook`,
`openwiki/agentic-retrieval.md`, `bench/README.md` and this file; follow
`ponytail`; no backward-compatibility logic; do not spawn subagents; do not edit
`human/` except to append code references; report needed decisions instead.

## What this replaces and what it reuses

The pilot script `bench/rag/scripts/knowledge_base_pilot.py` already does the
per-book work as separate commands over a manifest and a run directory: `parse`
(local parser container on 18091, spool, `corpus.json` with chunks, excerpts,
figures, regions, confidence and reasons), `refresh-figures`, `index` (embed with
Qwen3-Embedding-4B through DeepInfra into the local pilot Postgres on 15437),
`prepare-tags` + `normal --stage tags` (roles, topic ids, synopsis, evidence per
excerpt through a normal API provider), `prepare-summaries` + `normal --stage
summaries` + `export-summaries` (one book summary), and the loader
`bench/rag/scripts/knowledge_base_library.py publish` (bucket object check, book
version, pointer swap into the live library). The playground
(`lab/playground`) is the model for the dashboard: FastAPI, one HTML page,
SSE, a launch entry, secrets lifted from `.env.local`, its own tunnel.

Not reused: the summaries stage (dropped by decision), the Batch client
(`collect`/`recover`, historical), the headless Claude Sonnet recovery arm
(retired), the evaluation and materials commands (bench only). The bench recovery
arms (`bench/parsers/scripts/compare_*_recovery.py`) stay as frozen comparisons;
their crop rendering, request shape and validation are the reference for the
recovery stage, not a dependency.

## Layout

- `lab/` is the home of developer-PC tools that are not benchmarks (decided
  2026-09-19): `lab/playground/` (moved from `bench/rag/playground`, paths
  updated) and `lab/knowledge/` for the builder.
- `lab/knowledge/` — `server.py` (FastAPI, port 18766), `ui.html`,
  `store.py` (SQLite), `scrape.py` (workflow 1), `ingest.py` (workflow 2 stage
  runner), `recovery.py`, `topics.py`, `llm.py` (routing), `README.md` (the
  scraping agent's instructions and the licence policy; committed because
  `data/` is ignored), `subjects.json` (areas and subjects, written),
  `books.json` (the committed manifest the loader reads, exported by the
  builder from SQLite; the pilot manifest's three books are its first entries
  and each entry gains `subject_id`). Tests in `lab/knowledge/tests/`.
- `data/knowledge-base/` (ignored) — `sources/<sha256>.pdf` downloads,
  `builder.sqlite`, `runs/<book>/` per-book run directories (the pilot's run
  layout: `books/<id>/corpus.json`, `models/tags/...`, receipts), `logs/`.
- `.claude/launch.json` entry `kb-builder` (local, untracked).

## Storage (SQLite, `store.py`)

- `urls(url PK, host, status pending|visited|skipped|failed, discovered_from,
  depth, added_at, visited_at, verdict json)` — the URL queue and visited set.
- `downloads(pdf_url PK, landing_url, title, authors json, edition, subject_id,
  level, language, licence, licence_url, licence_evidence_url, evidence_quote,
  status queued|downloading|downloaded|rejected|failed, attempts, last_error,
  sha256, path, bytes, pages, added_at, finished_at)`.
- `books(sha256 PK, book_id, manifest json, status new|queued|running|
  published|failed, stage, queue_position, run_dir, error, added_at,
  published_at, version)` — the ingestion queue and history.
- `stage_runs(id, sha256, stage, started_at, ended_at, exit_code, log_path,
  usage json)` and `llm_calls(id, stage, sha256, model, endpoint, request_id,
  input_tokens, output_tokens, elapsed_ms, ok, error)` — receipts.
- `settings(key, value)` — worker states (running/paused per workflow), the
  recovery sample rate, per-host delay.

"Processed before" = sha256 in `books` with status published, or a
`library_book_versions.object_key = 'books/<sha256>.pdf'` row (current or
retained) in the live library, checked when the dashboard lists the folder.

## Model routing (`llm.py`)

One function `complete(messages, schema, images=None, stage=...)`: default
endpoint Ollama (`http://127.0.0.1:11434/v1/chat/completions`, model
`glm-5.3-flash:cloud`, thinking off unless a stage asks), fallback Tencent
TokenHub (`TOKENHUB` from `.env.local`, wire model `glm-5.3-flash`) on connection
error, timeout or a 5xx, never on a schema failure (that is retried once on the
same endpoint, then recorded as failed). Structured output through
`response_format` JSON schema where the endpoint honours it, with local schema
validation regardless. Every call writes an `llm_calls` row. Images travel as
base64 data URLs. The pilot's `knowledge_base_realtime.py` gains an `ollama`
provider entry so the tags stage runs through the same routing.

## Workflow 1: scraping and download (`scrape.py`)

A loop the dashboard starts and pauses:

1. Pop the oldest `pending` URL whose host is past its delay (default 5 s per
   host; robots.txt fetched once per host and honoured; a disallowed URL is
   `skipped`).
2. Fetch with a 30 s timeout and a 20 MB HTML cap. A `Content-Type:
   application/pdf` or `.pdf` response is not downloaded here: it becomes a
   `downloads` candidate carrying the landing page's verdict.
3. Extract text and links (absolute, deduplicated, same scheme). Call the model
   once with the page text (clipped to 12k tokens) and the link list under a
   schema: `{relevant: bool, subject_id: str|null, level: secondary|
   undergraduate|graduate|other, language: str, licence: {name, url,
   evidence_quote}|null, pdf_links: [{url, title, authors[], edition}],
   follow_links: [url], reason}`. The subject list in the prompt is the fixture's
   subjects with aliases.
4. Programmatic gate: `pdf_links` whose licence passes `licence_accepted()`
   (CC BY, CC BY-SA any version, CC0, public domain; evidence quote and URL
   required) and whose language is English and level is secondary or
   undergraduate go to `downloads` as `queued`; others are recorded `rejected`
   with the reason so the dashboard can show near misses. `follow_links` go to
   `urls` as `pending` with depth+1, capped at depth 4 and 2,000 pending per
   host; already-seen URLs are dropped in the store.
5. The download worker (separate loop, two at a time) fetches `queued` PDFs
   with three attempts and exponential backoff, streams to a temp file, hashes,
   rejects duplicates by sha256 (recording the duplicate URL against the
   existing row), moves to `sources/<sha256>.pdf`, counts pages with PyMuPDF,
   marks `downloaded`.
6. A `downloaded` row appears on the dashboard with its evidence; the developer
   adds it to the ingestion queue (manual gate). Adding creates the `books` row
   and the manifest entry (id from title slug, sha256, bytes, pages, licence
   fields, attribution line, `subject_id`, `first_content_page` left null until
   parse fills it).

The README for scraping agents states the licence policy, the subject list, the
depth and host caps, and that the model never writes to the store directly.

## Workflow 2: ingestion (`ingest.py`)

The worker runs one book at a time through these stages, each a subprocess of
the pilot or loader command with `--book`, stdout and stderr to
`logs/<sha>/<stage>.log`, streamed to the dashboard over SSE:

1. `parse` (existing; needs the parser container and the pilot Postgres up).
2. `figures` (existing `refresh-figures`).
3. `topics` (new, `topics.py`): read `corpus.json` section paths (the table of
   contents), load the subject's existing topics from the live library, call the
   model once with both under a schema `{reused: [topic_id], proposed:
   [{id, label, aliases[], scope, source_sections}]}`; merge by id and by
   normalised label or alias; write `topics.json` in the run dir; if the subject
   would exceed 64 topics, stop the book as failed with the message to split the
   subject. The dashboard shows reused and proposed before tagging runs.
4. `recovery` (new, `recovery.py`): candidates = chunks with `confidence < 0.8`
   or an `uneven_table` reason or any `confidence_reasons`, plus a 3% random
   sample of the rest (seeded by sha256 so it is reproducible). Four workers;
   for each chunk render its regions' union box with 24 pt padding and the
   whole page at 1568 px longest edge with PyMuPDF from the local PDF; send both
   images, the extracted text, the previous and next chunk texts, under the
   schema `{faithful: bool, corrected_text: str|null, math: [str], notes: str}`
   with the transcription rules from the bench arms (preserve notation, no
   invented content, LaTeX for formulas). A `faithful: false` with
   `corrected_text` replaces `text` and `indexed_text` in `corpus.json` and the
   chunk gets `recovery: {original_text, model, endpoint, request_id, usage,
   at}`; `recovery.json` in the run dir summarises counts and cost. Sample
   chunks that come back unfaithful are reported on the dashboard as an audit
   signal, not acted on differently.
5. `index` (existing; must accept `--book`).
6. `tags` (existing prepare + normal stage through `llm.py` routing; candidates
   are the subject's topics from step 3; must accept `--book`).
7. `publish` (loader): upload `sources/<sha256>.pdf` to the knowledge-base
   bucket if `head_object` misses, publish the book version with descriptor =
   manifest attribution line and summary = the top-level section titles joined,
   upsert the subject's topics, then drop library topics with no tagged excerpt
   anywhere. Records `version` on the `books` row.

Pause: the worker checks a flag between stages; the current stage finishes. A
non-zero exit marks the book `failed` with the stage and log path; retry
re-runs from that stage (the pilot's stages are idempotent per run directory).
Removing a book from the queue is refused while it is `running`.

Dependencies panel: `docker ps` for `capy-kb-postgres-v4-pilot` and
`capy-kb-parser-v4-pilot` with start buttons (`docker start`), the library
tunnel (reuse `lab/playground/scripts/common.py` `ensure_tunnel` for the
15433 forward only), Ollama reachability (`/api/tags`), and the bucket
credentials present. The worker refuses to start a stage whose dependency is
down and says which.

## Library and curate changes (small contract change)

- `library_subjects(id PK, area, label, aliases jsonb)` loaded from the fixture
  by the loader's `schema` and refreshed on every `publish`; `library_topics`
  gains `subject_id` (FK). The pilot's 32 topics get `subject_id = 'statistics'`
  and the pilot manifest gains `subject_id`. Plain schema change: drop and
  republish, as the loader already requires.
- `library.catalog()` returns subjects that hold at least one tagged excerpt,
  with counts; `browse(subject_or_topic)` returns the subject's topics with
  counts for a subject id, or excerpts as today for a topic id. The
  `browse_knowledge` description carries the subject list; `search_knowledge`
  points at it and keeps `topics` as topic ids (unknown ids still refuse naming
  the catalog). Contract version 7, regenerated; the curate prompt's step 1 says
  "browse a subject to see its topics, then a topic".
- Ops Library page: subjects column and filter; export unchanged.

## Dashboard (`ui.html`)

One page, three panels: Sources (folder listing with sha256, pages, licence,
status, "add to queue"), Scraping (URL queue add/remove, visited count, per-host
counts, downloads with evidence and reject reasons, start/pause), Ingestion
(ordered queue with move up/down and remove, the running book with its stage
and live log, topics diff for review, recovery counts and cost, start/pause,
retry), plus a dependencies strip and a model strip (default and fallback
endpoints, calls and tokens today).

## Tests (focused)

`store.py` queue operations and dedupe; `licence_accepted()` table; URL
normalisation and depth/host caps; download hashing and duplicate handling with
a local HTTP fixture; topic merge by id, label and alias and the 64 stop;
recovery candidate selection and the apply step on a small `corpus.json`;
stage runner pause and failure semantics with a fake command; `llm.py` fallback
on a connection error but not on a schema failure. No live-model tests.

## Verification

One new open textbook (an OpenStax title in a subject the library lacks)
through the whole path from URL to the live library, with the receipts, then a
curate turn in the playground on that subject; the curate retrieval eval
unchanged for the statistics books; `pnpm test:go`, the pipeline tests touched,
`pnpm fmt:py`, `pnpm gen:api:full` clean; docs: `openwiki/agentic-retrieval.md`
(taxonomy, browse change, builder), `openwiki/deployment-runbook.md` (nothing
deployed changes except the library schema republish), `bench/README.md`,
`openwiki/test-catalog.md`.

## Assumptions to confirm at review

- A1 `bench/rag/builder/` is the code location and `data/knowledge-base/` the
  data location (the README for agents is committed with the code).
- A2 Scraping accepts only English books at secondary or undergraduate level,
  per the 2026-09-16 library decision; other languages are recorded as rejected.
- A3 The recovery audit sample is 3% and the per-host delay 5 s.
- A4 Book summary column holds the top-level section titles, not model text.
- A5 The pilot Postgres and parser containers stay as they are; the builder does
  not build or migrate them.

## Landed 2026-09-19

Both halves implemented and verified: the builder under `lab/knowledge/` (63
tests), the taxonomy change (subjects table, subject catalog, two-level browse,
contract v7, ops subjects, loader), the live library republished with the eval
unchanged (105/105, five excerpts for 21 of 22), and OpenStax *Physics* taken
from a scraped catalog record through download, parse, topics, recovery, index,
tags and publish into the live library (4 books, 55 topics, 2 subjects).
Deviations from the plan, all recorded in the implementers' reports: thinking
off is sent as `reasoning_effort: low` (the cloud model ignores `thinking:
false`); the loader `publish` takes `--config`; two empty mirror tables
(`materials`, `rag_material_contents`) were added to the library schema because
the shared hybrid-search statement now joins them; recovery crops one image per
page for chunks spanning pages; TOC reduction strips heading levels shared by
90% of chunks. Open for Epo: the audit sample found 32 of 93 unflagged physics
chunks unfaithful, so the candidate rule under-selects; OpenStax has moved most
titles to CC BY-NC-SA, which the gate rejects.
