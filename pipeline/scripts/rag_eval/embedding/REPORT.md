# Embedding evaluation, 6 September 2026 UTC

The retrieval results do not justify switching from Qwen3-Embedding-4B. Qwen3
8B at 2,560 dimensions is effectively tied on the current hybrid search. Moving
to 4,000 dimensions adds storage and computation without a measured relevance
benefit. Voyage 4 large has the highest hybrid ranking score, but the difference
is uncertain and its dense-only coverage is lower.

The complete agent comparison also favors retaining 4B on these cases. Both
conditions still expose failures in following references and supporting absence
claims; changing the embedder does not resolve those problems.

## Retrieval quality

All conditions use the same 19,821 indexed chunks across eleven lab workspaces.
There are 19,564 distinct embedding inputs. The scored broad comparison has
360 questions, forty each from seven MIRACL languages, SciFact and ArguAna.
The other two workspaces contain the curated agent corpus and its missing-source
control. Search keeps the frozen application SQL, lexical weighting, forty
candidates, five output passages and a four-passage per-file cap. BEIR excludes
the query's own document. Exact distance ordering isolates embedding quality
from HNSW approximation. Each condition was re-embedded independently; vectors
were never mixed between models.

| Model and dimensions | Hybrid hits / 360 | Hybrid nDCG@5 | Dense hits / 360 | Dense nDCG@5 |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 4B, 2560 | 318 | 0.6579 | 343 | 0.7650 |
| Qwen3 8B, 2560 | 319 | 0.6580 | 340 | 0.7713 |
| Qwen3 8B, 4000 | 318 | 0.6574 | 340 | 0.7708 |
| Perplexity embed-v1-4b, 2560 | 317 | 0.6618 | 340 | 0.7543 |
| Voyage 4 large, 2048 | 318 | 0.6711 | 330 | 0.7521 |

The cohort-stratified paired bootstrap uses 2,000 resamples. Every challenger's
95% interval for the change in hybrid or dense nDCG includes zero. For hybrid
nDCG, the changes and intervals versus 4B are:

| Challenger | Change | 95% interval | New hits / lost hits |
| --- | ---: | ---: | ---: |
| Qwen3 8B, 2560 | +0.00011 | -0.01414 to +0.01365 | 7 / 6 |
| Qwen3 8B, 4000 | -0.00053 | -0.01448 to +0.01269 | 6 / 6 |
| Perplexity | +0.00390 | -0.01359 to +0.02201 | 7 / 8 |
| Voyage | +0.01317 | -0.00636 to +0.03127 | 9 / 9 |

There are meaningful cohort tradeoffs hidden by the aggregate. Both Qwen 8B
widths lose two Japanese hybrid hits against 4B. Voyage gains four Korean hits
and loses four ArguAna hits. Its dense search gains six questions and loses
nineteen. The complete cohort metrics and paired query IDs are in `summary.json`.

The fresh 4B baseline matches the earlier hybrid total of 318. Dense hits rise
from 342 to 343 because one German jellyfish question gains a relevant passage
at position five. `baseline-drift.json` preserves that difference; this experiment
does not establish its cause.

## Storage and HNSW

Physical sizes include Postgres page allocation and TOAST where applicable.
HNSW uses half precision, cosine distance, `m=16` and `ef_construction=64`.

| Model and dimensions | Table MiB | HNSW MiB | Index build seconds | Corpus embedding seconds |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 4B, 2560 | 119.4 | 152.9 | 21.5 | 221.1 |
| Qwen3 8B, 2560 | 119.4 | 152.9 | 19.8 | 411.0 |
| Qwen3 8B, 4000 | 197.8 | 305.7 | 34.3 | 394.8 |
| Perplexity, 2560 | 119.4 | 152.9 | 21.6 | Interrupted; see below |
| Voyage, 2048 | 106.6 | 152.9 | 15.0 | 88.2 |

The 4,000-dimension index doubles in physical size even though vector width grows
by 56.25%. Conversely, Voyage's narrower vectors do not shrink this HNSW index.
These measured allocation effects should replace linear storage estimates for
this configuration. Table plus HNSW storage rises from about 272 MiB at 2,560
dimensions to 504 MiB at 4,000, before ancillary indexes. Wider responses also
carry more data over the embedding API. The measured 2,560-dimension 8B route
still has much longer query waits than 4B in this session. Bulk embedding uses up to four concurrent batches of 64.
Perplexity returned three HTTP 429 errors. Their paid successes were retained,
and only the missing 192 inputs were resumed at concurrency one after inspection.
Its saved `embedding_s_including_cache` is the resumed pass, not full-corpus
throughput. The request timestamps show about 64.9 seconds for the initial
306 calls and 4.0 seconds for the three resumed calls, separated by an inspection
pause. Those timestamps have one-second resolution. All failed requests remain
in the record.

A separate 360-query diagnostic forces HNSW over a shared index with workspace
and self-document filtering. It compares neighbors against exact vector ordering,
without hybrid fusion or the per-file output cap. Recorded plans prove HNSW use.
The natural direct-vector plans are also saved; these are not claims about the
planner for the application's full hybrid SQL.

| Model | ef40 top-40 overlap | ef40 searches returning <5 | ef100 iterative top-40 overlap | ef100 p95 milliseconds |
| --- | ---: | ---: | ---: | ---: |
| Qwen3 4B | 60.7% | 2 | 98.2% | 38.4 |
| Qwen3 8B, 2560 | 62.0% | 12 | 97.2% | 50.1 |
| Qwen3 8B, 4000 | 62.9% | 3 | 98.2% | 50.0 |
| Perplexity | 55.4% | 0 | 97.4% | 25.9 |
| Voyage | 56.4% | 6 | 95.6% | 36.4 |

The second arm uses `ef_search=100` and `hnsw.iterative_scan='strict_order'`.
It returns at least five results for every case. The first uses `ef_search=40`
and iterative scanning off. Neighbor overlap measures approximation, not whether
passages answer the question. A small, warm lab corpus cannot establish production
capacity or the best settings for large workspaces.

## Query API latency

The fixed 36-query sample was run three times at concurrency one and four,
with condition order shuffled. All 1,080 requests succeeded. These calls bypass
the application cache and have no retries; provider-side caching is uncontrolled.
The figures include network time from the ingest VM and the tested provider route.

| Model | Sequential p50 / p95 ms | Concurrency 4 p50 / p95 ms | Concurrency 4 completed requests/s |
| --- | ---: | ---: | ---: |
| Qwen3 4B | 200 / 562 | 231 / 1563 | 7.88 |
| Qwen3 8B, 2560 | 1531 / 13752 | 1753 / 7734 | 1.38 |
| Qwen3 8B, 4000 | 1712 / 12622 | 961 / 5474 | 2.37 |
| Perplexity | 151 / 190 | 155 / 337 | 20.54 |
| Voyage | 223 / 274 | 241 / 519 | 14.41 |

Qwen 8B had long tail waits during this run. Reducing its output width did not
remove that operational disadvantage. The difference between the two 8B widths
should not be read as a reliable dimension effect: the same route was measured
in different time blocks, and latency was highly variable. These are descriptive
route measurements from one session, not an SLA or an intrinsic model-speed ranking.

## Agent answers

See the [follow-up trace analysis](TRACE-ANALYSIS.md) for the exact point where
chains break, matched intermediate queries and examples of early stopping. The
public retrieval benchmark and curated agent benchmark use different questions
and sources; their aggregate scores are not a causal comparison on identical
agent inputs.

The selected challenger, Voyage, and the 4B baseline each answered the same
48 curated questions twice: 80 answerable and 16 missing-information attempts
per condition. All 192 first attempts completed without transport or tool errors.
Both use the fixed `follow_links_ids` behavior, exact hybrid search, and the same
DeepSeek chat pin (`deepseek-v4-flash-vision-exp`, version 1). Three setup/pilot
conversations are retained separately and excluded from these counts.

Every answer was checked against its tool results and frozen sources by Codex.
This is a source review, not independent human grading or a blind assessment.
The three labels distinguish requested-answer correctness, support for material
claims, and citation support for the required chain. A fully supported answer
must pass all three. [The protocol](review-protocol.md) and
[all 192 reviews](answer-reviews.json) make the judgments inspectable.

| Measure | Qwen3 4B | Voyage 4 large |
| --- | ---: | ---: |
| Correct answer on answerable cases | 75/80 | 65/80 |
| Fully supported answer on answerable cases | 67/80 | 52/80 |
| Correct answer on reference-chain cases | 28/32 | 18/32 |
| Correct handling of missing information | 12/16 | 14/16 |
| Fully supported missing-information answer | 1/16 | 3/16 |
| Questions fully supported in both repeats | 30/48 | 22/48 |

All direct lookups, PDF table questions and version comparisons passed the full
source review for both conditions. Comparison answers gave the right values in
all eight attempts per condition, but often cited only the procedure manuals,
leaving out the links from the named specimens to those procedures. That made
four of eight 4B comparison answers and all eight Voyage answers fail the
citation criterion.

Four 4B and fourteen Voyage reference-chain attempts stopped before completing
the chain and incorrectly claimed the answer was missing. One further 4B answer
gave the correct settings but miscounted the ivory-striped specimens and invented
ambiguity. On the Japanese glossary question, one 4B attempt offered two
alternatives instead of resolving the target, while one Voyage attempt answered
for the wrong specimen. Both retrieved the glossary. The automated check counted
76/80 4B positives as having the expected values and all evidence; the unresolved
Japanese answer is why that exceeds the 75/80 source-reviewed correctness count.

The missing-information tests are not all equally successful refusals. One 4B
answer invented `CT-635 → AX-635` from the shared numeric suffix and returned
45°C/100 minutes, despite the control workspace having no assignment register.
Other failures said no incubation applied or no DNA sequence was measured when
the sources only lacked that information. Most remaining negative answers
withheld the requested value correctly, but made categorical claims about all
workspace documents after ranked searches and partial reads. Those claims fail
the groundedness/citation criterion even when the full frozen corpus confirms
that the answer is absent. Complete inventories missing the assignment registers,
combined with the course brief and targeted searches, support the few fully
supported cannot-determine answers.

Agent continuation matters alongside retrieval. For Voyage's `bridge-09`, the
two repeats issued the identical first search and received identical passages.
One continued to the register and succeeded; the other stopped after a field-note
read. `stopping-comparisons.json` retains that comparison. This establishes that
identical initial retrieval can lead to different answers; it does not attribute
all differences between embedders to the chat model.

The source-integrity check verified all 2,923 returned passages against their
frozen workspace text, every inline citation reference, the constant chat model
pin, and complete, stable source inventories. These checks validate the record;
they do not make every generated claim correct. Repeats share questions, and the
curated set has already been used for development.

## Implications for Capy

The default Qwen3 8B output is 4,096 dimensions. Its supported shortened outputs
let it fit the [pgvector HNSW halfvec limit of 4,000](https://github.com/pgvector/pgvector#hnsw),
as verified by the actual 4,000-dimension build here. There is no need to use the
maximum width to use the 8B model.

An 8B model at the same width still defines a different embedding space. Old 4B
document vectors cannot be searched with 8B query vectors. The current repository
pins a workspace's embedding model at creation. A default change applies to new
workspaces; there is no existing reindex job that converts old workspaces.

Adding a model requires its registry entry, vector table and mapping in both Go
and Python. The query and ingest paths must resolve the same model, version and
dimension. Reusing cached vectors or cloning an index is valid only for the same
space. Keeping 2,560 dimensions saves storage but does not avoid these changes.
The relevant contracts are documented in `openwiki/agentic-retrieval.md` and
implemented in `pipeline/pipeline/retrieval/store.py` and `models.py`.

Voyage also requires query/document input-role shaping. This experiment supplies
that explicitly in its isolated adapter. Perplexity uses unprefixed inputs.
The Qwen routes retain the existing query instruction and raw indexed documents.
All provider responses passed count, dimension, finite-value and nonzero-norm
checks before storage. No application model or workspace pin was changed.

At the checked DeepInfra rates, [4B costs $0.02 per million input tokens](https://deepinfra.com/Qwen/Qwen3-Embedding-4B)
and [8B costs $0.01](https://deepinfra.com/Qwen/Qwen3-Embedding-8B).
The approximately 4.15 million corpus tokens therefore cost about $0.083 for 4B
and $0.042 for each 8B condition. OpenRouter receipts put Perplexity corpus
embedding at about $0.124 and Voyage at $0.493. These are embedding costs only.
Pricing, rate limits and queueing belong to the tested routes. They are not
inherent properties of model size. Perplexity's saved endpoint metadata labels
its serving quantization `int8`; returned vectors were requested as floats and
stored as halfvec like every other condition.

## Scope and reproducibility

The plan fixed the conditions and challenger-selection rule before execution.
The best hybrid nDCG challenger, Voyage, was used in the agent comparison, while
its cohort and dense regressions remain visible. This selection does not make it
a statistically established winner.

These are reused public and fictional comparison cases. MIRACL uses reduced
candidate pools, relevance labels can be incomplete, and prior agent work has
already inspected the curated questions. Bootstrap intervals describe variation
within this sample, not performance on a fresh domain. Agent repeats share their
question and cannot be treated as independent test cases.

The runtime is the preserved curated lab image at revision
`a903b8e917144701186b9c6cd2a6bbeea1bd15f9`, with pgvector 0.8.6. Sources, runtime
hashes, source fingerprints, raw attempts and provider metadata are retained.
See `README.md` for reproduction and artifact definitions.

## Archive and cleanup record

The raw results are saved under
`/Users/sam/Downloads/capy-embedding-eval-20260906/`, in
`capy-embedding-results-20260906.tar.gz` and the separate
`capy-embedding-vector-cache-20260906.tar.gz`. The latter contains the original
float32 cache and its own content hash. Together they preserve sources, scripts,
provider receipts, query plans, vectors, first attempts and answer reviews.

The pre-cleanup audit confirms unchanged hashes for 478 older lab artifact files,
31 workspace embedding pins and all evaluated source-chunk fingerprints. It
identifies exactly 195 new conversations (192 scored, three pilots) and their
390 persisted messages. Cleanup is scoped to those conversations, the dedicated
scratch vector schema, the new container, temporary credentials and new VM files.
It preserves older lab data and billing records and restores reused containers
to their initially stopped state. The final `cleanup.json` is written beside
these archives after verification and deletion, with the archive checksums and
observed final state.

Cleanup completed at 16:01 UTC on 6 September 2026. The scratch schema, 195
new conversations and 390 messages were removed. The temporary container,
credential files and VM result files are absent; all nine retained lab containers
are stopped. All 478 older artifact hashes still match. See [cleanup.json](cleanup.json).
