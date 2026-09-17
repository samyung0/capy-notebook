# Local knowledge-base pilot

Status at 07:46 UTC on 2026-09-16: local parsing, indexing and baseline retrieval completed. All 12 tagging batches are accepted and processing. A finite local continuation process is running. This report does not establish production readiness or independently reviewed teaching quality.

Later September 16 status: that continuation stopped at tagging with `failed_shards`. The first collected shard has 199 valid responses and one `invalid_json` response. Partial outputs remain preserved; the comparison and generated study samples are incomplete. The separate shared-parser recovery and MinerU experiments do not modify or resume these Batch jobs. Current state is recorded in `data/knowledge-base-pilot/run/driver-state.json`.

## Experiment

Epo authorized a complete local data-pipeline trial with existing model APIs. Alibaba Qwen3.8-Flash calls use the asynchronous Batch API. DeepInfra supplies Qwen3-Embedding-4B vectors. No generated figure captions, external storage service or production database is involved.

The runner reuses the production parser, block packing, heading retention, confidence scoring, embedding calls and hybrid-search SQL. Windows cannot import the full production ingest worker because it imports `fcntl`; the runner calls its constituent chunking functions directly. It does not execute the production queue, app authorization, B2, account credits, chat loop or material writes. Generated study materials are local benchmark artifacts.

Inputs are pinned in [the book manifest](../fixtures/knowledge-base-pilot-books.json) and [24 frozen requests](../fixtures/knowledge-base-pilot-questions.json). Sixteen requests are development cases and eight are held out from catalog construction. Topic candidates derive from book tables of contents. Labels are agent-authored, not human-certified. Scoring labels must never enter ingestion, search or generation prompts.

| Source | Edition used | PDF pages |
| --- | --- | ---: |
| OpenIntro Statistics | 4e, screen-reader PDF updated 2022-10-21 | 465 |
| Advanced High School Statistics | 4e, screen-reader PDF updated 2026-04-10 | 514 |
| Learning Statistics with jamovi | 2025, author-hosted snapshot downloaded 2026-09-16 | 495 |
| Total | | 1,474 |

The two OpenIntro sources have shared lineage. Their agreement is not independent corroboration. The author-hosted jamovi PDF can change at its URL; the manifest SHA256, not the URL alone, identifies this run. Licences, exact URLs, copyright pages and figure exceptions are in the manifest and [corpus notes](../fixtures/local/2026-09-16-knowledge-base/README.md).

## Local setup

- Windows 11 Pro, Ryzen 7 3700X, 32 GiB RAM. Docker has approximately 15.6 GiB available. The GPU is not used by this parser or the hosted model calls.
- Source revision: `b79795b4d4c973f6792405123d7c50d2987c5581`, with this pilot's uncommitted benchmark additions.
- Parser image `capy-kb-parser:pilot`, built from the production Dockerfile at that revision. Container `capy-kb-parser-pilot`, port `127.0.0.1:18090`, 4 CPUs, 7 GiB memory limit, 3 GiB JVM heap, 1,800-second document timeout. Books run serially.
- Isolated `pgvector/pgvector:pg16` container `capy-kb-postgres-pilot`, port `127.0.0.1:15436`, database `capy_kb_pilot`. Port 55436 was unavailable on Windows; no remote database is used.
- Local PDFs under `bench/rag/fixtures/local/2026-09-16-knowledge-base/`. Ignored service configuration, credentials, source spool, model receipts and outputs under `data/knowledge-base-pilot/`.
- [Example configuration](../fixtures/knowledge-base-pilot-config.example.json) records explicit parser limits. Both parser and client must use them. The local schema indexes every page but excludes front matter from eligible search rows.

## Findings so far

### All three full books parsed on this PC

| Book | Pages | Parser-reported elapsed time | OCR pages |
| --- | ---: | ---: | ---: |
| OpenIntro Statistics | 465 | 54.839 s | 0 |
| Advanced High School Statistics | 514 | 38.210 s | 0 |
| Learning Statistics with jamovi | 495 | 136.261 s | 22 |
| Total | 1,474 | 229.310 s | 22 |

These are successful parser receipt times, excluding the initial failed attempts, image build, client chunking, embedding and model queues. The parser container peaked at 2,773,680,128 bytes, approximately 2.58 GiB, across the three successful parses and recorded no OOM kills. This supports local parsing feasibility for these books; it does not measure scanned-only textbooks or the app under concurrent user load.

The corpus contains 3,861 chunks and 2,315 contiguous heading excerpts. Its 875 figure records comprise 435 parser image/chart occurrences and 440 caption/page references. These can overlap and are not 875 unique illustrations. The three original PDFs total approximately 122 MiB; raw parser images add approximately 173 MiB before bundle copies, vectors and request caches. Local scratch usage should not be mistaken for the size of a published PDF-plus-index library.

At the post-index checkpoint, the local database occupied 48.7 MiB, the parser spool 289.4 MiB and run artifacts 503.8 MiB. Run artifacts include expanded bundles, vector caches, batch input copies and diagnostic receipts. Source PDFs and Docker images are additional. There is no evidence here that this three-book test needs a hosted database or object bucket.

The jamovi PDF also exposed an overly strict validator in the new pilot. Its cover image has a small print-bleed box outside the page. The pilot now reuses the production geometry validator, retains the exact source coordinates and marks out-of-page bounds. The completed parser bundle was reused, so this correction did not require parsing the book again.

### The default image limit rejects a complete textbook

OpenIntro Statistics initially failed with `parser image exceeds configured byte limit`. This was a per-image byte guard, not an out-of-memory kill. After increasing pilot-only limits, the same full PDF parsed in 57.11 seconds and chunked in 6.94 seconds, producing 1,341 production chunks and 890 contiguous heading excerpts. Its largest extracted image is 35,549,292 bytes, above the default 32 MiB ceiling.

The pilot uses a 128 MiB image limit, 512 MiB combined-image limit, 512 MiB artifact limit and 1 GiB expanded-artifact limit. Production defaults are unchanged. These are explicit local test settings, not a recommendation to enlarge production upload limits. Initial failed-attempt resource evidence is retained in `parser-initial-health.json`.

### Image blocks alone do not describe all textbook figures

A visual check of OpenIntro Statistics PDF page 50 shows a histogram, Figure 2.6, and a table, Figure 2.5. The parser's first image-only figure inventory records no figure on that page. Vector-drawn charts can remain text and drawing content rather than image blocks. Figure relationships therefore need original caption/page anchors and page capture even when no image crop exists.

The pilot now adds `caption_page_reference` records with the original caption and caption box, tied to a full-page capture. It does not invent a crop box around the unseen chart. These records and embedded image records are distinct, so their combined count must not be reported as a count of unique illustrations.

The same loan-interest histogram appears in Advanced High School Statistics PDF page 28 as Figure 1.18. The source captions, local figure numbers, surrounding exercise and page coordinates differ. This is a concrete reason to group related explanations without merging their source records or transferring one edition's figure link to another.

Some running page headers and captions also appear in the extracted heading path. For example, page 50 contributes `50 CHAPTER 2. SUMMARIZING DATA`. A heading-based excerpt is therefore a candidate teaching unit, not a guarantee of a clean lesson boundary. The pilot must report these cases rather than assume all heading paths are editorially sound.

An explicit running-header pattern appears in 201 of OpenIntro Statistics' 890 excerpt paths and 243 of Advanced High School Statistics' 990 paths. It appears in none of the 435 jamovi paths. Across all books, 202 excerpts are shorter than 160 characters, including front matter and caption units. These are diagnostic counts, not an error-rate estimate: each candidate still needs a source check. The figures and paths are recorded in `run/source-audit.json`.

### Provider preflight

DeepInfra returned a vector with the required 2,560 dimensions. Usage is recorded in `run/embedding-usage.jsonl`.

Alibaba accepted a one-request Qwen3.8-Flash batch, `batch_a178d757-4e2d-4e7b-9954-a90e86e59567`, on the supplied Beijing workspace endpoint. Two earlier attempts had unknown transport outcomes and no job visible in the queried listing. Their receipts are retained. The accepted diagnostic uses the documented `ds_name` and `ds_description` metadata fields, with the input hash in the description. Routine resume reconciles existing jobs rather than silently resubmitting uncertain creates.

The preflight is still processing at this report checkpoint. Acceptance is not evidence of completed model inference. The Batch guide lists Qwen3.8-Flash support while its individual model page currently says otherwise, so live completion is the required check. [Batch guide](https://help.aliyun.com/en/model-studio/batch-inference), [model page](https://help.aliyun.com/en/model-studio/qwen3-8-flash).

The 2,315 tag requests occupy 26,263,825 bytes. An initial whole-file upload and a 2,189,594-byte shard upload timed out through `httpx`. The identical shard uploaded through `requests` in 3.625 seconds and returned a processed-file receipt with the expected byte count and hash-derived filename. A 10,120-byte real-excerpt probe also succeeded, but a later `requests` upload timed out too. Changing HTTP clients alone did not resolve the intermittency.

A DNS-route diagnostic found two addresses for the supplied endpoint. An unauthenticated `/files` request routed to `101.201.58.201` timed out during TCP connection; the same hostname routed to `47.94.20.201` returned the expected HTTP 401 in 1.11 seconds. A temporary process-local resolver route to the responding, DNS-advertised address retained the original hostname, Host header, SNI and TLS certificate verification. No system DNS or production configuration changed. Through this route, submission of all 12 tag shards completed in 64.77 seconds. Do not hardcode this address into the service: it is a dated local network workaround, and later runs must check current DNS and reachability.

At 07:39 UTC on 2026-09-16, all 12 tagging jobs were `in_progress`, with 2,315 total requests and no completed results yet. Each file and job receipt is saved. The standalone preflight was also still `in_progress`. No synchronous inference fallback was used.

## Comparison and review

Arm A uses existing hybrid candidates and the existing per-file cap. Arm B adds confident, evidence-checked topic/role matches to the same candidate pool. Query tags come from catalog aliases and fixed role rules, not expected-answer labels. This measures that bounded tag-ranking intervention; it does not establish that the topic catalog is complete or the best retrieval design.

Both arms use the same source excerpts and generation instructions. One primary source supports each explanation. Original alternatives survive. No semantic deduplication classifier or deletion is introduced in this trial.

Material generation is text-only. Figure IDs and author captions do not prove the model inspected a chart. Local page captures support source review, but visual-question quality needs actual image inspection in a later agent integration check.

Review source support, missing coverage, notation consistency, repetition, exercise validity, figure fit and attribution. A model's structured output and valid source IDs are necessary checks, not proof of teaching quality. No A/B quality score is available yet.

### Completed baseline and source spot-checks

All 3,861 vectors are stored, with 3,764 chunks eligible for search after front-matter exclusion. All 24 baseline queries completed through production hybrid-search functions. Results are in `run/retrieval-baseline.json`. The small pilot uses exact vector scans rather than an HNSW performance test. Learner levels are stated in the frozen query text; answer labels are not model input.

Replaying indexing left the 3,861 stored vectors unchanged and made zero additional embedding calls. The excerpts preserve adjacent production-chunk overlap, rather than reconstructing clean textbook sections. Measured exact adjacent overlap is 5.9% of excerpt characters for OpenIntro Statistics, 5.6% for Advanced High School Statistics and 14.2% for jamovi. These repeated spans can affect model input cost and output repetition; no source content was deleted to conceal them.

The 24 baseline searches took a median 0.312 seconds each, ranging from 0.140 to 0.453 seconds. This includes hybrid SQL, connection setup when needed and local ranking/result assembly, but excludes query embedding time. Eight requests returned several chunks from the same excerpt among their five hits. Material preparation reads each selected excerpt once; duplicate-aware search selection remains a separate candidate experiment.

Seven figure captures were rendered through the production capture function. Source inspection confirmed readable full-page caption references and image crops, including the annotated box plot on Advanced High School Statistics page 45 and the jamovi box plot on page 100. A retrieved figure can still be unsuitable: the histogram request's first captured page discusses kurtosis, which is a poor starting point for the requested beginner exercise. Figure capture correctness and teaching relevance are separate checks.

The following are agent source-review observations, not aggregate accuracy scores:

| Request | Observation | Consequence |
| --- | --- | --- |
| `stat-09`, confidence intervals | Retrieves the interval interpretation, repeated-sampling coverage and an explanation of the common probability misconception. | Existing hybrid search can assemble relevant teaching evidence across these books. |
| `stat-05`, conditional probability | Ranks chapter learning objectives above the worked explanations. | A topical match need not be a useful explanation. Role tags have a specific hypothesis to test. |
| `stat-12`, paired versus independent t-tests | A Wilcoxon discussion is first; directly useful t-test material appears later. | Related material can displace the intended introductory explanation. |
| `stat-15`, regression | Retrieves the same Elmhurst College example in dollars in OpenIntro Statistics and thousands of dollars in Advanced High School Statistics. Intercepts are 24,319 and approximately 24.3 respectively. | Keep source variants separate and check units before combining them. Similarity is not a licence to merge numeric statements. |
| `stat-17`, standard error versus standard deviation | The first result is an answer-key chunk from OpenIntro Statistics page 431. Its text renders the fraction 27/212 as `21227` and loses square-root/fraction structure in the standard-error formula. The chunk confidence is 0.946 with no confidence-reason flags. | Parser confidence is not mathematical correctness. Equation-sensitive exercises need source-page verification or reviewed corrections. |
| `stat-16` and `stat-24`, absent biology/advanced-mathematics coverage | Search still returns five nearby textbook passages. | Retrieval itself does not abstain. The generation/agent test must reject unsupported requests. |

The regression spot-check also found a source error. Advanced High School Statistics page 461, Example 5.22, prints `0.431(1000)` in the worked substitution after correctly giving the coefficient `0.0431`. The stated result of -18.8 matches 0.0431, not 0.431. Visual inspection confirms the typo exists in the PDF itself. The pilot preserves the source unchanged; it must not treat a faithfully extracted textbook passage as automatically correct.

These findings support separate checks for source/extraction quality during library preparation and learner-specific diagnosis during the study loop. A full prerequisite graph is still unnecessary for this trial. Proposed next editorial work is a small exception queue for malformed equations, source errata, noisy headings and incompatible units, with explicit corrections kept separate from immutable source text.

### Confidence audit follow-up

The current score measures token agreement with the source PDF text layer, plus page coverage and a limited pipe-table shape check. It is a heuristic extraction score, not a calibrated probability that a passage is correct. Its tokenizer removes punctuation and mathematical operators, and the agreement check ignores token order. It does not validate section hierarchy, equation structure, table cell association, figure-link completeness or the truth of the source.

The current passage-warning threshold is strictly below 0.9. Counts below use the same `page_start >= first_content_page` eligibility rule as the local search index:

| Book | Searchable chunks | Score below 0.9 | Distinct pages spanned by those chunks |
| --- | ---: | ---: | ---: |
| OpenIntro Statistics | 1,311 | 64 | 36 |
| Advanced High School Statistics | 1,389 | 49 | 31 |
| Learning Statistics with jamovi | 1,064 | 15 | 29 |
| Total | 3,764 | 128 | 96 |

Thus 3.4% of searchable chunks enter a score-only queue. This is a queue-size estimate, not a measured parser error rate. OCR-routed chunks receive a fixed 0.5. Other low scores indicate text disagreement, incomplete page coverage or uneven pipe-table column counts. Twelve low-scoring chunks have no reason string: the text-disagreement reason starts below 0.85, whereas passage warnings start below 0.9. Eight searchable chunks have a reason string despite scoring at least 0.9, so a score-only filter would also miss those flags.

Confirmed examples that pass the current warning threshold:

| Example | Score | Stored reasons |
| --- | ---: | --- |
| OpenIntro Statistics page 431, lost fraction and square-root structure | 0.946 | None |
| OpenIntro Statistics page 50, running header included in the excerpt's section path | 1.000 | None |
| Advanced High School Statistics page 461, faithfully extracted printed coefficient typo | 0.996 | None |

A direct call to the existing scoring function also assigns 1.0 with no reasons when a sentence's `x < y` becomes `x > y`, or a formula's minus sign becomes a plus sign, provided the surrounding page has a text layer. The symbols are removed before comparison. Exact source/example receipts and counts are in `run/confidence-audit.json`.

Proposed review workflow, not implemented or added to the running batches: queue low scores and every reason flag, plus equation/table/heading/figure-risk candidates and a sample of high-scoring passages. Group nearby candidates by source page for efficient review. Give a vision-capable reviewer the original page or crop, extracted text and neighboring context when visual structure matters. Return a typed issue and proposed correction with source evidence, then let an operator accept, edit or reject it. Preserve original text and machine scores; keep an approved correction and review status separately and rebuild affected derived excerpts, tags and embeddings in a new corpus version. Printed source errata must remain distinguishable from extraction repairs. The active Qwen Batch jobs currently assign topics/roles and produce text artifacts; they are not a visual extraction audit.

### Current assessment

- This PC can parse and index this three-book corpus with substantial memory headroom. A separate hosted database or B2 bucket adds nothing necessary to this test.
- Preserving complete source variants is justified by the changed regression units and edition-specific figure links. Suppressing repeated retrieval hits is safer to test before semantic source deletion.
- Author captions plus page capture are workable for the inspected figures, provided vector charts also receive caption/page anchors. Image blocks alone miss useful figures.
- Ingest-time source checks remain necessary. Learner scores can guide exercise selection, but they cannot establish whether an extracted fraction or textbook coefficient is correct.
- Topic/role tagging and generated-material quality are still unproven. Accepted Batch jobs, valid JSON and traceable source IDs do not answer that question; completed outputs and source review do.

## Cost accounting

Report provider-returned tokens per stage and distinguish calculated list-price estimates from settled account charges. At the checked rates, Beijing Qwen3.8-Flash is CNY 0.8 input and CNY 2.7 output per million tokens, with Batch advertised at 50%, giving CNY 0.4 and CNY 1.35 respectively. DeepInfra lists USD 0.02 per million tokens for Qwen3-Embedding-4B. These are separate currencies; promotional credits and account-specific discounts are not inferred. [Alibaba pricing](https://help.aliyun.com/en/model-studio/model-pricing), [DeepInfra model pricing](https://deepinfra.com/Qwen/Qwen3-Embedding-4B).

Completed embedding calls total 1,081,946 provider-reported tokens across 124 calls, including preflight and the 24 query embeddings. The calculated cost is USD 0.021639. Summed embedding request time is 381.612 seconds. This is API time, not total wall-clock execution time. Alibaba token usage and cost remain unknown until completed Batch outputs arrive; pending work is not zero-cost evidence.

## Code and reproducibility

- [Pilot runner](../scripts/knowledge_base_pilot.py) reuses production components and exposes each stage separately.
- [Batch client](../scripts/knowledge_base_batch.py) saves immutable JSONL inputs, file/job receipts and collected output. Missing, failed, truncated and unknown-ID responses cannot become a completed stage. An uncertain create is reconciled before another create is allowed.
- [Offline tests](../scripts/test_knowledge_base_pilot.py) cover these boundaries, shard resume, source identity, vector-chart page anchors and material provenance. Expected-answer labels remain outside ingest and generation prompts.

From the repository root in PowerShell, the common arguments are:

```powershell
$pilotArgs = @(
  '--manifest', 'bench/rag/fixtures/knowledge-base-pilot-books.json',
  '--config', 'data/knowledge-base-pilot/config.json',
  '--run', 'data/knowledge-base-pilot/run'
)
```

The completed local stages were `parse`, `index`, `evaluate-baseline --questions bench/rag/fixtures/knowledge-base-pilot-questions.json` and `capture-evidence --baseline-only`. Every stage is an argument to `.venv/Scripts/python.exe bench/rag/scripts/knowledge_base_pilot.py`, followed by `$pilotArgs` using PowerShell splatting, `@pilotArgs`. PDF hashes and embedding cache identity prevent silent input substitution.

The current continuation is `finish --questions bench/rag/fixtures/knowledge-base-pilot-questions.json --workers 4 --timeout-seconds 300`. It prepares strict-schema requests, reuses schema-valid historical tags, runs normal API calls with thinking disabled, and then runs summaries, retrieval comparison, captures and material export. It does not reparse or re-embed the corpus. New stages use `run/models`; historical Batch receipts stay under `run/batches`.

To verify the new code without model calls:

```powershell
.venv/Scripts/python.exe -m pytest bench/rag/scripts/test_knowledge_base_pilot.py -q
pnpm run fmt:py
uv --native-tls run --with ruff ruff check --no-force-exclude bench/rag/scripts/knowledge_base_batch.py bench/rag/scripts/knowledge_base_pilot.py bench/rag/scripts/test_knowledge_base_pilot.py
```

The explicit Ruff invocation matters because the repository formatting command excludes `bench/`. No production runtime code was modified by this experiment.

Verification at this checkpoint: 19 offline tests passed; root formatting, explicit benchmark formatting/lint and `git diff --check` passed. Changed tracked/untracked candidate files were checked against the supplied credential values and contained no matches. Large PDFs and local secrets/artifacts are ignored by Git.

### Initial continuation, historical

The hidden local continuation started at 07:46 UTC on 2026-09-16 and completed its first provider status check. At that checkpoint it was waiting for tags. It polled every 300 seconds with a fixed 48-hour deadline and stopped on invalid output. This driver and the command below have been retired in favor of the normal API continuation.

The ordinary command is:

```powershell
.venv/Scripts/python.exe -u bench/rag/scripts/knowledge_base_pilot.py finish-pending @pilotArgs --questions bench/rag/fixtures/knowledge-base-pilot-questions.json --poll-seconds 300 --deadline-hours 48
```

This run uses the ignored `data/knowledge-base-pilot/finish-routed.py` wrapper for the temporary DNS route described above. It verifies that the selected address is still advertised by DNS at startup. Launch details are in `run/driver-launch.json`; the actual worker PID and latest status are in `run/driver-state.json`. Progress events are in `run/driver-events.jsonl`, with stdout/stderr beside them. Read these files before trying to start another worker. The current launcher PID is 71724 and its worker PID is 59412.

These PIDs and launch commands are historical. The normal continuation uses `run/realtime-driver.json`. After a crash or reboot, verify that a recorded process is no longer running before removing a stale lock. Requests with uncertain outcomes require an explicit retry; their saved attempts remain available for accounting.

### Tagging collection recheck, 11:25 UTC

This supersedes the initial waiting status. All twelve provider tagging jobs
finished. The local continuation stopped on invalid output; it was not waiting
for ODL. Fresh collection of the existing files found 2,308 JSON-decodable
responses, six invalid JSON responses and one provider HTTP 400
`invalid_parameter_error`, with no missing requests. The HTTP 400 says generation
under JSON response format became invalid and was aborted. No requests were
resubmitted and the downstream pilot was not resumed. JSON decoding alone does
not establish correct tag schemas or useful topic assignments.

The 2,314 responses with usage total 6,846,057 input and 374,452 output tokens.
Using the dated rates above gives an estimated CNY 3.24, not a settled account
charge. Individual provider jobs took about 55 to 142 minutes. The separate
Qwen vision-transcription comparison is still pending at this checkpoint.
Receipts are `old-tag-jobs-status-recheck.json`, `old-tag-jobs-collected.json`
and `old-tag-jobs-usage-recheck.json` in
`bench/parsers/reports/local/2026-09-16-selective-recovery/`.

The original pilot corpus remains parser v3 / chunker v9. Collecting its model
outputs does not rebuild that corpus using the shared parser fix. Before
continuing generation, the remaining work is to validate collected assignments,
resolve the seven failed responses and explicitly select the corpus version.

### Normal API and strict-schema continuation

The developer replaced asynchronous Batch with normal Qwen3.8-Flash calls,
thinking disabled, then requested structured output. New requests use strict
JSON Schema for tags, source summaries and study materials, with local schema
and provenance validation. Request intents, raw responses and usage remain
durable; explicit retries archive previous attempts. The API does not return
reasoning-token counts, so those counts are unavailable rather than zero.

Seven old failed tag responses were first recovered through normal JSON-object
calls. Nine attempts were needed, including two timed-out calls with unknown
usage; their known returned totals are 21,241 input and 1,380 output tokens.
After that recovery, all 2,315 outputs were JSON objects, but the old validator
found 31 schema violations. The new complete schema found 722 invalid outputs,
including 696 missing `proposed_topic` and one missing `evidence`, with overlaps
among violation types. It preserves all 1,593 valid results from identical
source prompts. Historical data remains under `run/batches`; current stages
are under `run/models`.

All 722 strict-schema tag requests succeeded on the first pass in 708.74 seconds
at four workers. Returned usage is 2,253,515 input and 146,236 output tokens,
estimated CNY 2.19765 at the dated normal API rates. Combined with reused outputs,
all 2,315 tag objects now pass schema validation. This validates shape, allowed
values and field bounds, not semantic quality or calibrated confidence.

The machine editorial queue contains 1,616 excerpts. Literal evidence matches
the source for 799 excerpts; six have confidence below 0.8, one proposes a topic,
and 127 have no topic assignment. Reasons overlap. A failed quote check can be
a paraphrase or formatting mismatch and does not prove incorrect classification.
Conversely, matching text does not prove that the chosen topic or role is useful.
Only evidence-verified, confident tags contribute to the B reranking arm.

The continuation retains the original v3/v9 corpus for comparison. Shared v4/v10
parser verification is recorded separately; no reparse or reindex occurred here.
The [partial study review](2026-09-16-knowledge-base-study-sample-review.md)
uses six cases selected before study outputs existed. Only four selected
outputs were received, including one complete A/B pair. The reviewer found two
explanatory/mathematical errors and a missing sampling assumption. Unreceived
cases remain unreviewed. This is an agent source review, not independent human
validation or a representative accuracy estimate.

The three Qwen source-summary requests returned one success and two read
timeouts. LSJ completed in 103.27 seconds with 44,606 input and 672 output tokens.
OS4 and AHSS timed out at 300 seconds with unknown provider outcome/usage; the
command stopped after 303.48 seconds and retained both uncertain attempts.
`realtime-driver.json` therefore remains failed on summaries. Retrieval and
materials depend on the finished tags, so those independent stages were run
separately. All 24 retrieval comparisons and nine source-figure captures
completed. The material run stopped after repeated stalls: 18 calls started,
12 schema-valid outputs, one connection error, one read timeout, four
interrupted in-flight calls, and 30 unstarted requests. Raw receipts and partial
validation results are retained under `models/materials/realtime`;
`material-continuation.json` records `interrupted_after_stalls`. Known returned
usage is 44,632 input and 15,652 output tokens; six started calls have unknown
usage. No completed study-material export is claimed.

The [DeepSeek comparison](../../parsers/reports/2026-09-16-deepseek-comparison.md)
completed all three identical source-summary requests in 6.95 seconds. Its
separate tag/crop tests still show source-fidelity and schema-enforcement
limitations. These comparison outputs remain separate from the Qwen pilot.

## What remains outside this pilot

App library authorization, immutable attribution rendering, published/retired edition retention, operator overrides, learner-history adaptation, the curate progress ledger and long multi-tool turns require application integration checks. A successful local corpus run is only the data-pipeline feasibility result.

After testing, inventory available textbook sources before expanding acquisition. No additional database, B2 bucket, subject selection or test-key handoff is needed from Epo for this local run. Independent review of the sampled assignments and materials remains useful before publication.
