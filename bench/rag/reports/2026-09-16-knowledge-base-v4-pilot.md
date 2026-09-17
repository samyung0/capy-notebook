# Fresh knowledge-base pilot with ODL v4 and DeepSeek

Date: 2026-09-16. Local run authorized by Epo after accepting the bounded
transcription quality.

The local pipeline completed with recorded errors. It parsed and indexed all
three books, generated 1,892 valid tags plus two schema failures, three source
summaries and 48 study responses. Forty-four study responses passed export
checks; four failed figure attribution. Source review found additional teaching
errors. This establishes feasibility on this PC, not readiness for unattended
publication or a demonstrated benefit from topic reranking.

## Scope and isolation

- Same three licensed statistics textbooks and 24 frozen retrieval questions.
- Shared ODL parser v4 and chunker v10; ordinary application code, not a fork.
- DeepSeek Flash, thinking off, for tags, summaries and study materials.
- Qwen3-Embedding-4B through prepaid DeepInfra for 2,560-dimensional embeddings.
- New ignored run directory `data/knowledge-base-pilot-v4/run` and configuration
  `data/knowledge-base-pilot-v4/config.json`.
- New local containers `capy-kb-parser-v4-pilot` on localhost:18091 and
  `capy-kb-postgres-v4-pilot` on localhost:15437. PostgreSQL uses the separate
  Docker volume `capy-kb-postgres-v4-pilot`.
- The original v3/v9 database, model receipts and run directory remain intact.
  Existing embedding-cache entries can be reused only through their exact
  content-and-model keys.
- No production database, object bucket or deployed service is changed.

The parser release identity is the first 40 hex characters of the tested
source snapshot hash, `b3fa048946997fb598ed024fd4c2675b6d2e7139300c9888ed3d0e9d2211fe54`.
This is a local source identity, not a published Git release. The new parser
image ID is `sha256:495258462aeb92d238512c26c33862fa762baba490651b2c53f4d75696530b67`.

## Parsing and indexing

Fresh parsing has completed. Every complete chunk record exactly matches the
earlier independently verified v4 candidate, including source geometry and
confidence. Receipt: `run/parse-verification.json`.

| Book | Pages | Chunks | Source excerpts | Parse client seconds |
| --- | ---: | ---: | ---: | ---: |
| OpenIntro Statistics | 465 | 1,255 | 695 | 86.06 |
| Advanced High School Statistics | 514 | 1,334 | 775 | 59.92 |
| Learning Statistics with Jamovi | 495 | 1,090 | 424 | 188.34 |
| Total | 1,474 | 3,679 | 1,894 | 334.33 |

These timings include client/artifact handling; they are not controlled
throughput comparisons. Indexing and all 1,894 DeepSeek tagging requests are
tracked with local schema and provenance validation. Indexing has completed:
3,679 vectors, 3,585 searchable chunks and zero chunks missing their vector.
The local database occupies 49,888,279 bytes at this checkpoint, including
Postgres overhead. This is a small exact-vector-scan pilot, not a capacity test.
There were 56 new embedding calls for 1,741 texts; 1,938 corpus vectors reused
exact content-and-model cache keys. All 24 baseline retrieval requests finished,
with a median 0.305 seconds excluding query embedding.
The combined pilot and DeepSeek adapter checks pass: 30 offline tests through
`pnpm test:pipeline -- bench/rag/scripts/test_knowledge_base_deepseek.py bench/rag/scripts/test_knowledge_base_pilot.py -q`.
The adapter preserves native request/response records and archives explicitly
retried attempts, including unknown usage. It never labels reused Qwen output
as a DeepSeek result.
The closing review found no actionable issue in the error-recording changes
and independently checked the two retained tag failures, 44 exported artifacts,
four absent rejected artifacts and `completed_with_errors` status. The review
is saved locally at `C:/private/tmp/knowledge-pilot-errors-review.md`.

This run uses fixed ODL output throughout ingestion. Automatic region selection
and replacement by LLM transcription is not enabled. The earlier reviewed crop
transcriptions remain a separate selective-recovery experiment.

## Retrieval and study output

Both retrieval arms completed for all 24 frozen questions. A uses the production
hybrid search and per-file cap. B boosts confident, quote-verified role/topic
matches within the same 40 candidates. Twelve questions retain identical top
five ordering; eleven change their selected set and eight change the first hit.
The first full A/B pass had median search time 0.336 seconds, excluding query
embedding; the cached final replay measured 0.360 seconds and retained the same
material inputs. These are context changes, not evidence that B teaches better.

All 48 study responses passed JSON Schema validation. Four failed the separate
figure-to-attributed-excerpt check: `stat-10-B`, `stat-18-B`, `stat-20-A` and
`stat-23-B`. The failed responses remain in native/model results. They were not
repaired or exported. The other 44 are available under `run/materials/` with
source attribution. `run/material-export.json` records every outcome, and
`run/realtime-driver.json` reports `completed_with_errors`.

The [study review](2026-09-16-knowledge-base-v4-study-review.md) checks the same
six preselected questions, all 12 A/B responses and their 50 practice questions.
It finds incorrect general SD scaling and an omitted variance calculation,
missing CLT conditions, and a box-plot response that repeats the book's mistake
of treating observation labels as numerical values. Both out-of-scope theorem
requests were refused. A/B contexts are identical for four of the six selected
cases, so generation differences there cannot be attributed to tags. The
sample is purposive and agent-reviewed, not a corpus-wide accuracy estimate.

All three source summaries completed. Obvious wording defects remain: the
AHSS descriptor and LSJ summary misdescribe full-book input as front matter or
a table of contents. These summaries were retained unchanged. Notes:
`run/summary-review-notes.json`.

There are 25 local source-figure captures. Study generation received text and
figure metadata, without image pixels. Figure IDs and model limitations are
retained in JSON, but the Markdown exporter does not render those figures or
limitations. The selected box-plot A artifact therefore does not deliver the
requested activity using an actual displayed textbook figure. This run does not
validate visual reading or the full application agent loop with learner history
and iterative tools.

## Usage and timing

| Stage | API attempts | Input tokens | Cached input tokens | Output tokens | Median request seconds | Estimated new USD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Tags, including four retries | 1,898 | 6,436,599 | 5,328,253 | 268,428 | 1.327 | 0.3433 |
| Book summaries | 3 | 201,306 | 0 | 2,271 | 5.280 | 0.0316 |
| Study responses | 48 | 234,317 | 31,616 | 56,849 | 5.437 | 0.0646 |
| New embeddings | 56 | 536,331 | Local reuse counted separately | 0 | Not compared | 0.0107 |

The new API cost estimate is **US$0.4502**, including the four retries. All
DeepSeek attempts report usage and zero reasoning tokens. Calls occurred in
the off-peak window. This estimate applies the checked
[DeepSeek rates](https://api-docs.deepseek.com/quick_start/pricing/) and
[DeepInfra embedding rate](https://deepinfra.com/Qwen/Qwen3-Embedding-4B) to
receipts, and is not a provider invoice. It excludes earlier experiments,
the original purchase of reused vectors, local hardware and storage costs.
Receipt: `run/usage-summary.json`.

The first tag pass took 688.63 seconds with four workers. Its four-request
retry spent 427.00 seconds in the reused helper, mostly replaying cached local
validation. These times include local overhead. Parser client time was 334.33
seconds for all 1,474 pages. This run was not a controlled capacity or peak
memory benchmark.

## Source and tag checks

The first tag pass returned 1,890 schema-valid responses and four schema
failures. One explicit retry resolved two. Epo accepted recording the remaining
two failures as-is, without further repair or retry:

| Excerpt | Source | Validation error | Handling |
| --- | --- | --- | --- |
| `exc_f213361bf057b0_11` | OS4, PDF p7, preface overview | 12 topic IDs, maximum 5 | Failed, untagged; omit its synopsis |
| `exc_0689cddaba206d_7` | AHSS4, PDF p7, preface overview | 13 topic IDs, maximum 5 | Failed, untagged; omit its synopsis |

Both preface excerpts were already excluded from searchable chunks by the
frozen first-content-page rule. Original and retry responses remain unchanged;
the tag stage remains failed with 1,892 valid results and two errors. The pilot
driver accepts only these named schema failures through the local decision
record `run/accepted-tag-failures.json`. Missing, uncertain and transport
failures still stop downstream work. No failed result becomes a successful tag.

The retry's local replay is inefficient: the reused benchmark helper validates
and rewrites accumulated results after every cached receipt. It makes no new
provider call for a cached result. This overhead should not be reported as
DeepSeek inference latency or parser time; no optimization was made in this run.

The frozen tag sample contains four body excerpts per book, selected by the
smallest SHA256 of excerpt IDs before examining their outputs. All 12 reviewed
role/topic classifications are plausible against the supplied body and heading.
This is a small agent review, not a corpus accuracy estimate or a calibrated
confidence score. Notes: `run/tag-review-notes.json`.

Of the 1,892 valid tags, 1,777 pass the existing body quotation check. The
review queue contains 467 excerpts. Its overlapping reasons include 115
unmatched quotations, 245 confidence values below 0.8, 123 proposed topics and
93 empty topic lists. Among the 115 unmatched quotations, 32 match the supplied
heading alone. These are review signals, not 467 proven classification errors.
Receipt: `run/tag-quality-summary.json`.

Two sampled evidence quotations appear only in the supplied section heading.
The current validator searches the body alone, so it rejects these supported
heading quotations. They remain flagged in this run; the validator was not
relaxed after seeing the results. Table-cell accuracy was not established by
this tagging review.

Parser confidence also remains a heuristic, not a guarantee of correct numbers
or formulas. The fresh corpus has 52 of 3,679 chunks below 0.8, 109 chunks with
at least one confidence reason and 16 chunks flagged for uneven table columns.
A source transcription error can still have high confidence. These signals
can prioritize inspection, but cannot replace source checks. Receipt:
`run/confidence-observations.json`.

## Production storage

The local pilot is independent of production storage. A production deployment
needs durable PostgreSQL and private PDF/object storage. The proposed library
can share the application PostgreSQL instance, using library-owned records,
access controls and retention references. A dedicated library database server
is optional, not a prerequisite. This run provisions neither option.
