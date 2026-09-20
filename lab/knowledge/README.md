# Knowledge-base builder

A dashboard on the developer PC that finds open textbooks, downloads them and
runs each one through the pilot stages into the shared knowledge library.
Code here; PDFs, SQLite, per-book runs and logs under the ignored
`data/knowledge-base/`; the pilot and loader scripts stay in
`bench/rag/scripts/` and the builder calls them.

```sh
uv run --project pipeline python lab/knowledge/server.py --port 18766
# then open http://127.0.0.1:18766  (the Claude app's launch entry is kb-builder)
```

Secrets are lifted from the repository-root `.env.local`: `ALIBABA_API_KEY`,
`ALIBABA_BASE_URL`, `LIBRARY_DATABASE_URL`, `DEEPINFRA_API_KEY` and the five
`KNOWLEDGE_BASE_B2_*` values. Two models (`llm.py`): GLM-5.3-Flash on the local
Ollama cloud model (`glm-5.3-flash:cloud`, 127.0.0.1:11434) serves topics and
scraping; Qwen3.8-Flash on Alibaba Model Studio serves the transcribe and tag
stages. Both wait and retry on a connection error, a 429 or a 5xx (5, 20, 60 s;
a Retry-After in seconds is honoured, an HTTP date falls back to the pause),
retry a schema failure once and never fall back to another endpoint; every live
call is a row in `llm_calls`, and a batch task is one row with its totals once
collected. Both workflows start paused. On start, books left `running` and
downloads left `downloading` by a dead process go back to the queue; `waiting`
books keep waiting for their batch.

## Scraping: instructions for the scraping agent

The scraper runs ten concurrent page workers in `scrape.py`. SQLite atomically
claims each URL as `scraping` and reserves its host delay before fetching;
interrupted claims return to pending on restart. Downloads stay at two workers. The model judges one fetched page at a
time (catalog/book/other, subject, level, language, licence with its evidence
quote, PDF links, links to follow). Catalogs only discover book landing pages;
PDFs must be assessed on an individual book page. Site/footer licences do not
license its books. Direct PDF responses cannot inherit a referring page's
metadata. It never writes to the store: `store.py` is the single source
of truth, dedupe of URLs and files happens there, and the programmatic gate in
`scrape.gate` decides what is downloaded. A downloaded book normally waits for
the developer to add it to the ingestion queue from the dashboard. The Codex
intake monitor below can admit eligible downloads after Physics v2 is verified.
Both paths check metadata (title, authors, edition, licence, evidence) before
anything is parsed. Edition is optional; the licence evidence is
a URL or the PDF page stating it.

Licence policy (decision of 2026-09-19, applied verbatim by
`scrape.licence_accepted`):

> Accept CC BY, CC BY-SA of any version, CC0 and public domain, each with a
> licence evidence URL or PDF page recorded in the manifest; reject NC, ND,
> GFDL, ODbL, unknown licences and free-to-read pages without a licence.

Queue claims use indexed host activity lookups inside atomic updates. A busy
database returns HTTP 503 from dashboard actions; manual rejection runs outside
the event loop so it does not block other requests.

The download gate also requires a book page, a nonempty title, a
known subject, `language == "en"` and a classified level of `secondary`, `undergraduate`,
`graduate` or `other` (expanded by the developer on 2026-09-20). PDF and follow URLs must occur
in the extracted links; licence quotes must occur in the page text. Rejections are kept in
`downloads` with their reason so near misses stay visible.

Missing authors do not block download. At admission, a book with no supplied
authors requires an explicit source/PDF attribution review and an attribution
statement preserving supplied credits and notices. Its authors remain `[]`;
the manifest reader and publisher reject unreviewed authorless books.
Titles or filenames containing `Free Courseware` are rejected, case-insensitively;
URL escapes, underscores and hyphens in filenames are treated as spaces.

Subjects: the model assigns one `subject_id` from `subjects.json` (areas group
the dashboard; subjects are course-sized, with learner aliases). A book with no
fitting subject is not ingested; extend the fixture first.

Caps: robots.txt is honoured per host for pages and PDFs alike; one request
per host every 5 s (dashboard setting `host_delay_seconds`), counting page
fetches and downloads together, and never two downloads from one host at
once; links are followed to depth 4 from a seed; explicit `rel=next` links on
the same catalog path keep their depth, so pagination can continue beyond four
pages; at most 2,000 pending URLs per
host; pages are read up to 20 MB and clipped to about 12k tokens before the
model sees them; a PDF is capped at 200 MiB. The local builder parser container
uses `CAPY_MAX_SOURCE_BYTES=209715200` to match; preserve this override when
recreating it. PDFs download two at a time with
three attempts (waiting 5 s, then 20 s), are hashed while streaming, and a file
whose sha256 is already held is recorded as a duplicate URL on the existing
row; a file PyMuPDF cannot open is a failed row.

Page requests send `Accept: text/html`: Open Textbook Library returns empty
subject menus or Atom feeds to `*/*`. Extraction keeps both HTTP and HTTPS
links, including licence links on HTTPS pages. Each link sent to GLM retains
its anchor text, accessibility label and title so PDF and Hardcopy formats
remain distinguishable even behind opaque redirect URLs.

Seeds: add a URL in the dashboard's Scraping panel or run
`uv run --project pipeline python lab/knowledge/store.py add-url <url>`. Good
seeds are catalog subject pages (OpenStax subjects, the Open Textbook Library
subject lists, LibreTexts bookshelves) and publisher book pages that state the
licence next to the download link. Search results, login pages and social
links are poor seeds; the model is told not to follow them.

## Ingestion

One book at a time, from an ordered queue, through `parse`, `figures`,
`topics`, `transcribe`, `tag`, `index`, `publish` (`ingest.py`). Each stage is a
subprocess writing `data/knowledge-base/logs/<book_id>/<stage>.log`, tailed
live on the dashboard. Pause finishes the current stage; a failed stage marks
the book failed with its log and a retry resumes from that stage; a running
book is removable only when paused; a stage whose dependency is down pauses
the workflow with the reason instead of failing the book. Each book has its
own run directory `data/knowledge-base/runs/<book_id>/` with a one-book
`manifest.json`, so every pilot command works unchanged. Dependencies (pilot
Postgres and parser containers, Ollama, the library tunnel on 15433 only,
bucket credentials, the Alibaba key) are shown in the top strip with start
buttons for the containers. `books.json` here is the committed record of every
book added or published, merged by sha256 on add, after parse (which fills
`first_content_page`) and after publish (which records the version).

`topics.py` derives the book's topics from its table of contents, reusing the
subject's existing library topics and proposing new ones (two or three per
chapter, at most 64 per subject; past that the stage stops and asks for the
subject to be split; a proposed id equal to a subject id is renamed with a
`-basics` suffix and recorded under `renamed`). After the tag stage,
`topics.json` carries the tagged-excerpt count per topic and the dashboard
flags topics over 60; publish is not blocked.

`transcribe.py` sends one Qwen3.8-Flash request per page image: every page a
chunk touches is rendered once (PyMuPDF, zoom 1.4, JPEG 82) under
`<run>/pages/`, and each request carries the developer's page-description
prompt (thinking off, temperature 0) and returns `text`, the transcription,
plus `figures` (printed label and what each figure visibly shows) under a
strict JSON schema. By default a book goes through the Alibaba Batch API: page
images are uploaded to the knowledge-base bucket as `pages/<sha256>/<page>.jpg`
and presigned for 7 days, one JSONL line per page (`<book>:p<page>`) is
submitted as one task, the task id lands in `review_tasks` (one row per book
and stage), the book is `waiting` and the worker polls every ten minutes; once
the task is terminal the stage saves each answer as `<run>/pages/<page>.json`
and sends the pages still missing through the live endpoint once (a page that
fails both fails the stage with the count; retry re-sends only the missing
pages). The dashboard's "live endpoint" toggle sends every page live instead
(four in flight, one retry pass), for small books; it is refused while a batch
task is open, and a stage remembers the transport it started with. Recovery is
alignment, not model-labelled corrections: a chunk's original words are matched
against the transcription of its pages (concatenated for a page-spanning
chunk) in blocks of three or more words, extended over shorter blocks that
follow within a tight gap; the span from the first to the last block replaces
the chunk text under a `recovery` receipt (original text, method `align`,
coverage, ratio, model, request id) when coverage is at least 0.9 and the
span's length is within 0.7x-2.5x of the original. Otherwise the chunk is held:
the dashboard shows the page image, the original, the aligned span and the
full transcription with accept and reject; publish refuses while one is
undecided, and accepting puts the book back at `index` so the pilot Postgres
carries the new text before publishing. Chunks under 12 words with nothing
matched (table-of-contents fragments) are skipped and listed as
`unaligned_short`. A literal backslash-n the model escaped inside the JSON
string is unescaped unless it starts a LaTeX command. Every run reverts and
re-aligns from the saved transcriptions, so a rule change reaches every chunk
without a new batch and the receipt counts are book totals; decided held items
keep their decision. Figures: each returned figure is matched to the corpus
figures on its page by printed label, else by order; the description is stored
on the figure (`library_figures.description` at publish) and appended as
`[Figure <label>] <description>` to the `indexed_text` of the first chunk of
the excerpt that lists the figure, never to `text`. Each run writes
`<run>/transcribe-<timestamp>.json` (pages, aligned, changed, held,
unaligned_short, figures described, usage); `transcribe.json` holds the held
ledger. `--redo` reverts, discards the transcriptions and the ledger, archives
the batch state and submits a new task. Model directories of stages this round
replaced (`review`, `tags`, `recovery`) are moved to `<run>/archive/` so the
loader records this run's stages only.

`tag.py` tags the corrected excerpts, text only: eight excerpts per request
(corrected text, section path, id) with the candidate topics as id, label and
aliases in the system prefix, one array entry per excerpt id, thinking capped
at 4,096 tokens in Batch (`<book>:g<index>`), the same `review_tasks` and
waiting flow; excerpts missing from a reply after collection are re-sent
singly on the live endpoint (thinking off), and `--live` sends every group live
with one single-excerpt retry pass. The prompt asks for evidence as a
contiguous span of 5 to 30 words copied exactly from the excerpt text, no
ellipsis; the verifier (`knowledge_base_pilot.evidence_verified`, shared with
the pilot's `tag_outputs`) tolerates case and whitespace and splits on an
ellipsis with every piece verbatim, on the corrected text. Tags are written
through the pilot's `tag_outputs`/`tags_document`, so `tags.json` has the
`apply_tags` shape; more than 2% of excerpts untagged after the retry fails
the book with the count. Each run writes `<run>/tag-<timestamp>.json` (tagged,
verified rate, failed, review items, usage). The stage state under
`<run>/models/transcribe/` and `<run>/models/tag/` is what the loader records
as the book version's model runs. A killed stage leaves
`models/<stage>/command.lock`; the server removes stale locks at startup.

## Codex intake monitor

The `knowledge-builder-intake` heartbeat checks every five minutes. It stays
quiet until Physics v2 is published and its source/dashboard verification is
recorded. After that gate, it can automatically admit eligible downloads using
the existing licence, metadata, language, level, subject and hash checks.
Missing metadata is not invented. GLM still handles scraping and topics.

The monitor pauses the ordinary ingest worker before admitting a delegated
book, then runs parse and figures. Sol medium reviews the source and produces
corrected excerpts, semantic roles, full synopses and verbatim evidence.
Topics follows review: `topics.py --review-context <artifact>` sends every
excerpt's full notes plus the outline to GLM, omitting old topic IDs. A final
Sol pass assigns topic IDs against the new catalog. `--output <path>` allows
auditing a candidate catalog before replacing the run's `topics.json`.
Agents finish independently, save checkpoints silently, validate their own
work and return completed artifacts. The parent performs one final consistency
and import pass. Do not run the Alibaba stages concurrently on that book.
The dashboard's ordinary stage runner still uses the Qwen workflow above.

The monitor allows up to eight active books across preparation, source review
and indexing. Parser requests respect the configured document capacity. Up to
six Sol agents can run alongside the parent; large books can share those
slots through disjoint page/excerpt scopes. The parent imports completed
artifacts and advances the dashboard state through publication automatically.
No stage waits for user approval; existing validation and eligibility checks
still apply, and unresolved failures are reported.

The Physics trial and current repair artifacts are under
`data/knowledge-base/runs/physics/sol-trial/` and
`data/knowledge-base/runs/physics/manual-repair-2026-09-20/`. See the
[trial report](../../bench/rag/reports/2026-09-20-delegated-knowledge-repair.md)
for what has been checked and what has not. This monitor is attached to the
Codex task; it is not a timer inside `server.py`.

Checks: `uv run --project pipeline python lab/knowledge/server.py --check`;
tests: `uv run --project pipeline --extra test pytest lab/knowledge/tests -q`.
