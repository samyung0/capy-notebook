# Intake and retrieval comparison: plan

Date: 2026-10-06. Plan for review, nothing has run. Written after the
2026-10-06 design discussion with Epo (whole-book reading versus excerpt
search, review cost, MinerU) and two read-only audits of the current tools and
harness. Code references are `path:line` as of commit c51c3994.

## Decision this experiment informs

Whether library intake keeps full-page transcription review plus excerpt
tagging with excerpt-level search, or moves to a VLM parser with minimal review
and section-level reading. Two things are confounded in that question, the
parser and the reading mode, so the design separates them where it is cheap.

| Arm | Parser and review | Reading mode | Data |
| --- | --- | --- | --- |
| A | ODL v12 + full review (current published versions) | Current excerpt search, with the Part 1 fixes | Live shared library, versions pinned at run start |
| B | MinerU 4.0 standard tier on this PC's GPU, no transcription review, no tags, 3% audit measured only | Section reading (Part 2): outline, ordered section read, tag-free search as locator | Scratch library database |
| C | Same data as A | Section reading (Part 2) | Live shared library |

C costs only runs and answers "is the gain the parser or the reading mode".
A fourth cell (MinerU with excerpt search) needs tags, so it is out of scope.
Everything else stays fixed: the five PDFs by sha256, GLM-5.3-Flash thinking
high through the playground (`lab/playground/configs/chat.json`), the base
prompt and skills except the library rules named below, the request set, the
judge prompts, and the bench rule that both arms run under current code.

## Part 1: fixes to the current search tool (ship regardless of outcome)

From the audit of `pipeline/pipeline/retrieval/library.py` (lib), `tools.py`
(tools), `chunking.py`, `server/internal/agenttools/agenttools.go` (go).
Each is small; together they make arm A the current design at its best.

1. Book and section filters on `search_knowledge`. `library.search` passes
   `file_ids=None` (lib:454) although `store.hybrid_search` already filters by
   file ids, and `section_path` is in the `rag_chunks` view (lib:70). Add
   optional `book` and `section` arguments (go:526-546) so the model can keep
   practice in the same book and chapter as the explanation. Today a
   `roles=["exercise"]` search spans every book and nothing links practice to
   the explanation's book.
2. Continuation at the end of a read. `read_knowledge` reads only its own
   excerpt (lib:575) and ends with "(end of excerpt)" (tools:948-952). Return
   the next and previous excerpt ids of the same book by chunk order, with
   their section paths, so a chapter can be read in sequence without a search
   per excerpt. Add `count` (1 to 12) like `read_document` (go:494-500).
3. Silent skip after clipping. `next_start` is computed (lib:596-602) before
   the 8,192-token clip (tools:2253); a clipped page skips chunks without
   saying so. Compute it from what was shown.
4. One hit per section. Collapse (lib:479-493) only folds chunks of one
   excerpt or identical text; sibling micro-excerpts of one section (chunks
   per excerpt p50 1, p95 4) can fill all five slots. Fold hits of the same
   book and `section_path` into one, keeping the best chunk.
5. Context links with names. Links are shown as bare ids (tools:795-798);
   show section path and pages so the model can choose which to follow.
6. Repeated paragraphs in reads. Packing carries 50 to 200 trailing tokens
   into the next chunk (chunking:371-383), so consecutive "(chunk N)" bodies
   repeat text and `library_excerpts.text` concatenates the repeats. Suppress
   a chunk's leading text that equals the previous chunk's tail at read time;
   stored data stays as published.

Not in scope (data fixes, need republishing): merging tiny excerpts at build
time (`bench/rag/scripts/knowledge_base_pilot.py:472-496` groups consecutive
chunks by identical path, so a captioned table splits its section), and
per-book caps (the 2026-09-21 review's soft cap of 3 would spread one topic
over more books, the opposite of what the scatter complaint wants).

## Part 2: section reading tools (arms B and C)

- `browse_knowledge(book=<id>)`: the book's outline from `library_chunks`
  (distinct `section_path` ordered by first `chunk_idx`, with chunk range and
  pages), depth capped so a 500-page book stays under about 3k tokens.
  `library_book_versions.summary` holds only top-level titles and is read by
  nothing today.
- `read_knowledge(section=<book>:<path>, start, count)`: ordered chunks of a
  section. The range is the first matching chunk to the first later chunk
  whose path does not match (not a LIKE prefix alone, because a captioned
  table carries its caption as `section_path`, packing.py:246-248). Pages of
  up to 24 chunks, `next_start`, figures on those pages, and a read recorded
  for every excerpt covered so `create_material`'s `excerpt_ids` rule and
  `LibraryEvidence.observe` (tools:209-210, library_evidence.py:109) keep
  working. Provenance stays excerpt ids, so footers need no change.
- What the model sees. Not the whole book in one request: os4 alone is about
  465 pages, roughly 280k tokens, over the 250k admission ceiling before the
  prompt, ledger and output. Arm B reads the outline, then the sections the
  request needs, in book order, as many pages as it takes. A section read
  shows continuous text with one header per section and page markers, not a
  50-token header per chunk (about a quarter of today's passage tokens), so
  the model reads prose, not a list of passages. Chunks remain only the
  paging and provenance unit.
- Whole-book requests. A study set for many chapters runs on the ledger: one
  todo per chapter, read the chapter, write its note and quiz, move on; the
  checkpoint compaction drops the read text of finished chapters. This is the
  incremental reading Epo described and the six-chapter request below tests
  it.
- Tag-free search. Eligibility requires a verified tag (lib:139-157). A
  process flag (`CAPY_LIBRARY_REQUIRE_TAGS=0`, default on) lifts it for arm B,
  whose excerpts are untagged. Arm C keeps tags but does not filter by them.
- Library rules variant (`LIBRARY_RULES` in `prompts/chat.py`, overridden per
  playground config): search or browse to locate, read the section in order
  before writing, take worked examples and practice from the same section or
  chapter, cite book and pages. The building skill's "one book's notation"
  rule stays.

All of this is pipeline code plus contract entries; the playground runs the
pipeline's agent loop directly, so no Go deploy is needed for the experiment.

## Part 3: the MinerU arm

- Install: MinerU 4.0 (`pip install "mineru[torch]>=4.0,<5"`) in WSL Ubuntu
  (Python 3.10, GPU visible, 15 GB RAM) with CUDA torch; standard tier; small
  models on Torch, VLM on llama.cpp with GPU offload (vLLM only if the card's
  free VRAM allows; Windows holds about 2 GB of the 8 GB). Fallback: the
  repository's Docker image (`docker build -t mineru:4 -f docker/global/Dockerfile .`,
  CUDA 13 base, run with `--gpus all --shm-size 32g`); Docker Desktop passes
  the RTX 3060 Ti through (verified today). Every September MinerU test ran
  the 3.4.5 CPU pipeline backend; no GPU or VLM run exists.
- Smoke (done 2026-10-06): MinerU 4.0.10, `mineru-kit parse --tier standard
  --format zip`. The small models run on Torch CUDA; the 1.2B VLM runs on
  vLLM 0.28 at MinerU's default 0.75 memory fraction (6 GB) with
  `VLLM_USE_FLASHINFER_SAMPLER=0` because WSL has no nvcc; the llama.cpp
  engine that ships with the torch extra is CPU-only here and took 39 s a
  page, so it is out. Measured: 20 body pages of ahss4 (111 to 130) in 60 s
  of inference, 3.0 s a page, plus 37 to 85 s of engine start per invocation;
  about two hours for the five books. The standard tier fits the card, so
  no basic-tier decision is needed. Output is the middle JSON (blocks with
  type, 0..1 bbox, LaTeX equations, inline equation spans, table bodies,
  image paths) rather than a content list v1; the adapter maps it.
- Adapter: the retired `parser/mineru_worker.py` (git `711e3fe6^`) passed
  MinerU's content list through with page offsets, so the mapping is small. A
  `parse_books` sibling in the pilot script that takes a content list file
  instead of calling `parse_to_bundle` (`knowledge_base_pilot.py:550-602`) is
  the smallest insertion; the production chunker then runs unchanged.
  `page_chunks` (pilot:520-549) reads `refinement.json` for the frozen
  furniture list and optional page evidence, and falls back to the source
  PDF for heading retention and confidence scoring, so the MinerU path writes
  `refinement.json` with an empty furniture list (MinerU drops running
  headers and footers itself) and no page evidence, and records a MinerU
  identity in `release_sha`, `artifact_key` and `parser_fingerprint` so the
  corpus can never be mistaken for an ODL parse.
- Stages kept: parse, chunk, excerpts by section path, embed (same model pin
  as the live library, DeepInfra), publish. Stages skipped: transcription,
  figure description, review and tagging, topics, scope review. Publish needs
  a tag outcome per excerpt (`knowledge_base_library.py:152-185`); a tags
  document listing every excerpt in `failed_tags` keeps them ("a failed tag
  keeps its excerpt") with no loader change. Rights metadata (withheld pages,
  figure exclusions) is copied from the live book record; the pilot books
  have none. The source PDFs already sit in the bucket under the same sha256,
  so `capture_knowledge_page` works in every arm.
- Arm B build path (verified on the 20-page smoke corpus, 2026-10-06):
  `bench/rag/intake/scripts/mineru_corpus.py` maps the middle JSON onto
  Capy's content list (headings levelled by the PDF outline, a heading the
  outline does not know nests one level under the current one; inline
  equations as `$...$`, display equations as `$$...$$`, tables as HTML with
  captions, images and charts as image blocks with captions; header, footer
  and page-number blocks dropped) and writes `corpus.json` through the
  pilot's `page_chunks`, `figure_records`, `drawing_records` and
  `build_excerpts`, plus a one-book manifest, `topics.json` with no topics and
  an all-failed `tags.json`. `armb_pipeline.py` then runs the pilot `index`
  stage and the loader's `publish` per book. Arm B has its own pilot
  database (`intake-eval-pilot`, 127.0.0.1:15446): `book_identity` hashes id,
  edition, sha256, source url and licence, so the MinerU corpus of a live book
  has the live book's content id and the index stage would replace the live
  pilot rows. The converter's text-layer confidence runs low on formula-heavy
  chunks because the LaTeX differs from the PDF text (17 of 56 smoke chunks
  under 0.9); it is the same scorer for every arm and is reported, not used
  to filter.
- Audit (measurement, not repair): 3% of pages per book, fixed seed, each
  block judged faithful or not against the page image, for both the MinerU
  text and the live reviewed text of the same pages. This gives the parser
  error rate the arm's materials were built on and a direct ODL+review versus
  MinerU number.
- Scratch database: `pgvector/pgvector:pg16` as `intake-eval-scratch` on
  127.0.0.1:15445 (55443 sits in a Windows reserved port range), schema
  created 2026-10-06 with `knowledge_base_library.py schema`; publish with
  the shell `LIBRARY_DATABASE_URL` pointed at it (the shell wins over
  `.env.local`).

## Part 4: corpus and requests

| Book | Pages | Live version | Why |
| --- | ---: | --- | --- |
| os4 OpenIntro Statistics | 465 | v4 | pilot book, frozen questions |
| ahss4 Advanced High School Statistics | 514 | v5 | pilot book, frozen questions |
| lsj Learning Statistics with jamovi | 495 | v5 | pilot book, frozen questions |
| brief-calculus | 235 | v5 | formulas as pictures (Prince), repaired by hand |
| fundamentals-of-electrical-engineering-i | 364 | v12 | parser v12 catches 42% of its formula pictures |

2,073 pages for the MinerU parse. Physics (875 pages) only if throughput
needs a larger measurement.

Requests, frozen 2026-10-06 in `bench/rag/intake/fixtures/requests.json`
(32 requests, 40 turns per arm; the protocol in
`bench/rag/intake/fixtures/protocol.json` records the fixture hash):

- 8 generic learning flows shaped like the real app: the request with the
  app's default preferences, the agent's chapter proposal, a scripted
  confirmation, then the build. gen-01 asks for about six chapters of
  introductory statistics (the long incremental-reading test, the agent picks
  the book), gen-02 two statistics chapters, gen-03 a four-topic midterm whose
  confirmation edits the proposal, gen-04 is the open "Help me study
  statistics", gen-05 regression, gen-06 two chapters with jamovi (book
  choice), gen-07 differentiation in Brief Calculus, gen-08 circuit analysis
  in EE I. The proposal is judged too: one book, a sensible chapter count,
  the topics asked.
- 16 pilot questions from `bench/rag/fixtures/knowledge-base-pilot-questions.json`:
  14 answerable including two figure-dependent ones, plus stat-16 and
  stat-24 as refusal controls. They carry learner level and expected roles
  and have prior reviews.
- 8 formula requests on Brief Calculus and EE I with the expected section
  recorded: chain rule; product and quotient rules; l'Hopital's rule; the
  fundamental theorem of calculus; complex numbers and Euler's formula;
  Kirchhoff's laws with series and parallel resistors; Thevenin and Norton
  equivalents; Fourier series coefficients of a square wave.

Output is notes with embedded quizzes only, decks off (Epo, 2026-10-06:
decks are meant to be less text-dense and would not compare), study
preferences at the app defaults, Library on.

What a build produces, fixed in the request text so arms are comparable:

| Request type | Expected output | Good run (acceptance table, `lab/playground/README.md`) |
| --- | --- | --- |
| Pilot "learn X" question | One explainer note at the stated learner level, with a worked example from the book and a short practice set | Builds one explainer directly, cites the book |
| Formula request | One note: definition, derivation or rule as printed, one worked example, 3 practice items with answers from the book's exercises | Formulas match the page |
| Generic flow, few chapters | A proposal first; then one explainer note and one quiz of the preference default length per chapter, questions drawn from that chapter | Proposes chapters from one book, builds them on the ledger after the confirmation |
| Generic flow, six chapters (gen-01) | Six notes and six quizzes, one pair per chapter, on one ledger | All six todos done, one notation throughout, no chapter re-explains another |

Notes are markdown converted into the editor with quiz and flashcard fences
as embedded rows; `check_note` and `quizcheck` validate them in the
playground.

40 turns per arm, 120 over three arms, plus the 18 dev-split requests run a
second time per arm (about 66 turns more, roughly 186 in total). Variance is
known from the September reviews, so judging is pairwise with ties and the
repeat shows how much of a difference is generation noise.

## Part 5: runs

- Two playground processes on different ports, each with its own exported
  `LIBRARY_DATABASE_URL`; configs `intake-a.json`, `intake-b.json`,
  `intake-c.json` differing only in library rules, tool set and database.
- A driver posts each request to `POST /api/turn` sequentially (the process
  has one turn lock) and records run ids. Every run already saves the
  effective config, prompts, tool and provider calls with tokens, materials
  with provenance, and validator results (`lab/playground/local/runs/<id>/run.json`).
- Pin the five live versions at start (`knowledge_base_library.py status`)
  and check they did not change at the end; intake publishing is paused for
  the run window or the affected books are excluded from publishing.
- Counters per turn: tool calls, input and cached tokens, wall time,
  captures, sections or excerpts read, distinct books and sections cited.
- The Library toggle is on in every arm, which also enables the question
  bank. The bank stays available (production behaviour) and the number of
  copied versus written questions is recorded per quiz; if copies dominate
  the statistics quizzes, the quiz-bearing requests rerun with an empty bank
  restore so the comparison measures the library.

## Part 6: judging

- Mechanical: material saved, `check_note` and `quizcheck` pass, ledger todos
  completed, refusal on the two controls.
- Fidelity: the judge lists every formula, number and definitional claim in
  the material, then checks each against the cited pages rendered from the
  bucket PDF (the capture machinery). Score: claims, wrong, unsupported.
  Blind to arm; prompts frozen first.
- Coherence and fit: blind pairwise preference A vs B and A vs C on
  explanation to example to practice linkage (same section, one notation),
  completeness against the request, level fit.
- Locator: whether the first section read is on topic for the request.
- Multi-chapter builds: chapters completed, notation consistent across the
  six notes, no repeated explanations, and input tokens per chapter from the
  first to the sixth (does compaction hold the cost flat).
- Judge: Claude Opus 5.5 headless (`claude -p`, Max subscription, as in the
  2026-09-17 recovery comparison), a second model on 20% of pairs for
  agreement, and Epo spot-checks six materials (two per arm). Receipts under
  the ignored `bench/rag/reports/local/2026-10-intake-eval/`.

## Part 7: decision rule and outputs

- Ship Part 1 whatever the outcome.
- If C beats A on coherence with no fidelity loss, section reading ships on
  the current data regardless of parser.
- B replaces the current intake for new books only if its audit error rate is
  at or below the reviewed text's rate on the same pages, its fidelity score
  is not worse than A's, and cost per material stays within two times A's. If
  B's text is worse but C wins, keep ODL plus page transcription (the cheap
  part, about a dollar per book) and drop tagging; the alignment work goes
  away with section reading because the transcription can be the served text.
- Report: `bench/rag/reports/2026-10-<dd>-intake-retrieval-comparison.md`,
  with the protocol in `bench/rag/intake/fixtures/protocol.json` frozen
  before the first run and amendments in a separate file, as the rerank
  experiment did.

## Part 8: schedule and cost

| Phase | Work | Time |
| --- | --- | --- |
| 0 | Protocol and requests frozen; MinerU install and smoke parse; adapter insertion chosen | half a day |
| 1 | Part 1 fixes and Part 2 tools with focused tests; rules variant | one day |
| 2 | MinerU parse of 2,073 pages (GPU, one to two hours), index, publish to scratch; 3% audit on both texts | one day |
| 3 | about 186 turns, judging, report | one to two days |

Tokens: embeddings for about 15k chunks (cents); about 186 GLM-5.3-Flash
turns at roughly 100k to 300k input each, the six-chapter builds up to about
1M each, 25M to 45M input in total; judging through the Max subscription. No
ingest-host or UAT change.

## Decisions taken (Epo, 2026-10-06; recorded in `human/agentic-retrieval.md`)

1. Three arms.
2. The six Part 1 fixes ship to production regardless; pull and merge
   origin/main before the code changes.
3. MinerU route delegated to Claude: WSL pip first, the Docker image as
   fallback. If the standard tier does not fit the card, stop and ask; no
   basic-tier run without a new decision.
4. Judge: Claude Opus 5.5 at medium effort, headless; second model on 20% of
   pairs; Epo spot-checks six materials.
5. Question bank on in every arm, copies counted.
6. Intake is paused, so the live versions need no pinning or exclusion.
7. The 16 dev requests repeat once.

8. Request set as in Part 4, frozen in `bench/rag/intake/fixtures/requests.json`;
   output is notes with embedded quizzes only, decks off, default study
   preferences.

## Risks

- An 8 GB card is the documented floor for the standard tier; the smoke run
  decides, and basic tier changes what the arm measures.
- MinerU 4.0's content list may differ from 3.4.5's; the adapter step checks
  fields before anything else runs.
- Generation variance can hide small differences; pairwise judging with ties
  and the repeated dev subset bound it, and the audit gives a text-only
  number that does not depend on the agent.
- Arm B has no reviewed synopses or scope, so a book's printed errors are not
  flagged; this is part of what the arm measures.
