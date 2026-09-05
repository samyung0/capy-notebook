# Broad RAG evaluation, 5 September 2026

The current hybrid search found labeled evidence in 318 of 360 queries. A frozen
semantic-only comparison found it in 342. The largest gap was argument retrieval;
there was no uniform collapse on a non-English language. This is evidence to
investigate fusion ranking, not enough evidence to replace hybrid search globally.

The earlier prompt and document-location change preserved the expected core
answer on all 60 positive chat attempts per condition. It removed rejected
`read_document` calls, from 22 of 32 to zero of 54. Strict support for all material
claims rose from 54/60 to 57/60, while citation support rose only from 54/60 to
55/60. These small, dependent samples do not establish a broad accuracy gain.

The core-answer score is **not a score for factual correctness of the whole
response**. Several replies repeated errors already present in the public source
text, including a missing exponent in an electron count. This matters for a study
assistant even when the requested short answer and its citation are correct.

[Machine-readable results](results.json), [all 144 answer reviews](chat-review.json)
and [reproduction instructions](README.md) accompany this report.

## Scope and controls

This run used the existing isolated VM lab with new workspace IDs. It preserved
the earlier curated experiment, whose four raw-run hashes still match. No new
production prompt, ranking, model, or index change was selected or deployed.

- Source text was embedded with the actual `deepinfra/Qwen/Qwen3-Embedding-4B`
  workspace pin, version 1, at 2,560 dimensions. No precomputed vectors from a
  different embedding model were mixed into the index.
- Retrieval used chunker v5, top 5 passages, a per-file cap of 4, 40 candidates,
  and the current lexical weight of 0.5 with its existing short-query rule.
  The hybrid arm called the real search implementation. Dense comparators shared
  its query vector, workspace scope, file scope and result cap.
- There were 16,844 benchmark documents and 19,289 canonical chunks. Component
  fixtures used the application chunker, language detection, embedding model and
  index writer; they bypassed uploads, parsing and generated summaries.
- Chat used `deepseek/deepseek-v4-flash-vision-exp`, version 1. The baseline was
  revision `a903b8e917144701186b9c6cd2a6bbeea1bd15f9`. The candidate was the exact
  instruction and file-location rendering selected in the earlier experiment,
  applied through the same lab hooks. It changed neither search ranking nor the
  model/tool budget.
- The [plan](PLAN.md), data, scripts, model identities and index state were frozen
  before each phase. Retrieval froze at 13:26:40 UTC; chat at 13:39:20 UTC. No
  variant was tuned against these results. The final audit confirmed that all
  chat sources and index passages stayed unchanged.

## Retrieval by language and task

Every row has 40 deterministically selected questions. Hit@5 means at least one
labeled relevant document appears among the application's first five **passages**.
Repeated chunks consume positions but earn no extra document relevance. Recall,
nDCG and reciprocal rank use the same positions; aliases of identical canonical
content share the strongest label. Full metrics are in `results.json`.

| Dataset | Documents | Hybrid hit@5 | Dense hit@5 | Hybrid nDCG@5 | Dense nDCG@5 |
| --- | ---: | ---: | ---: | ---: | ---: |
| MIRACL English | 416 | 38/40 | 38/40 | 0.729 | 0.788 |
| MIRACL German | 414 | 38/40 | 37/40 | 0.680 | 0.728 |
| MIRACL Spanish | 400 | 39/40 | 39/40 | 0.700 | 0.731 |
| MIRACL French | 400 | 36/40 | 40/40 | 0.636 | 0.757 |
| MIRACL Japanese | 382 | 40/40 | 40/40 | 0.730 | 0.804 |
| MIRACL Korean | 576 | 36/40 | 39/40 | 0.666 | 0.764 |
| MIRACL Chinese | 399 | 36/40 | 37/40 | 0.635 | 0.744 |
| SciFact, scientific claims | 5,183 | 34/40 | 35/40 | 0.754 | 0.790 |
| ArguAna, arguments | 8,674 | 21/40 | 37/40 | 0.393 | 0.769 |
| All cohorts | 16,844 | 318/360, 88.3% | 342/360, 95.0% | 0.658 | 0.764 |

MIRACL uses its public development split and all judged positive and negative
passages for the selected questions,
2,987 documents across seven native-language pools. These reduced pools are easier
than the official full-corpus benchmark. SciFact and ArguAna use their full BEIR
corpora. BEIR queries exclude their own corpus item through the real file-scope
filter, following BEIR's standard convention. The [README](README.md#data-and-attribution)
links the dataset cards, licenses and evaluation convention.

Dense had higher nDCG in all nine cohorts, but hybrid alone succeeded on five
queries and dense alone on 29. German hit@5 was slightly better with hybrid.
A single aggregate would hide those tradeoffs.

An inspected ArguAna example, `test-law-lghbacpsba-pro02a`, asks for a rebuttal
about attorney-client privilege. The labeled rebuttal was dense rank 1. Hybrid
instead promoted passages about intercept evidence and juries, with vector ranks
12, 22, 17, 18 and 20. This is a concrete loss in fusion ranking. ArguAna is a
counterargument task, so it should not alone determine ordinary notebook search.

The labels also have limitations. For Korean MIRACL question `883`, a passage
explicitly labeled nonrelevant gives the same German-invasion-of-Poland explanation
as a positive passage. Published labels and all scores were kept unchanged.
Unjudged documents also receive zero relevance.

## Retrieval timing and exact reference

Dense and forced-exact dense returned the same top-five chunk IDs on all 360
queries. None of the 18 saved dense/exact plans used HNSW. This does **not** validate
approximate-index recall or billion-vector scaling.

Median SQL-path time was 1,039 ms for hybrid versus 114 ms for dense on ArguAna,
and 243 ms versus 72 ms on SciFact. MIRACL medians were roughly 22-34 ms versus
14-18 ms. These exclude embedding calls, run one client, and use a fixed
hybrid/dense/exact order. They are diagnostics for these queries and scopes,
not production latency estimates. Long argument queries and BEIR's large
file-scope filter are part of this workload.

## Chat comparison

The 36 fixed cases comprise 14 native MIRACL questions, eight MLQA questions with
different question/source languages, eight HotpotQA questions requiring two
source groups, and six derived missing-source controls. Each condition runs each
case twice, for 144 distinct first attempts. The 60 positive attempts per condition
represent only 30 distinct questions, not 60 independent examples.

MLQA and HotpotQA use 113 unique Markdown sources and 143 logical uploads through
the normal gateway, object store and ingest worker, including normal content reuse
for controls. All files became ready and indexed before chat. Native MIRACL chat
reuses component fixtures with source titles as descriptions and raw text as
summaries. Those native cases do not test generated summaries or upload parsing.

The original MLQA question gains its article title because the public task gave
the paragraph directly. The HotpotQA university rubric names Aligarh Muslim
University after checking the source; its original generic answer is retained.
Both choices were fixed before any chat turn.

| Measure | Earlier baseline | Prior selected change |
| --- | ---: | ---: |
| Expected core answer, positive cases | 60/60 | 60/60 |
| Core answer plus all material claims supported | 54/60 | 57/60 |
| All material claims have supporting attached citations | 54/60 | 55/60 |
| All labeled source groups reached | 59/60 | 59/60 |
| All labeled source groups cited | 59/60 | 58/60 |
| Explicit, accurate missing-source response | 10/12 | 10/12 |
| Missing-source response plus supported added claims | 8/12 | 8/12 |
| Completed attempts | 72/72 | 71/72 |
| Rejected document reads / all document reads | 22/32 | 0/54 |
| Mean search calls per attempt | 1.38 | 1.29 |
| Median completed-turn time | 5.02 s | 5.25 s |
| Mean completed-turn time | 6.03 s | 6.21 s |
| p95 completed-turn time | 12.06 s | 13.34 s |
| Mean reported tokens per completed turn | 6,847 | 7,772 |

The candidate had six paired gains and three losses on strict claim support.
It had six gains and five losses on citation support. An answer can use a valid
alternative proof without reaching every labeled passage. Conversely, retrieving
all labeled passages does not prove that every additional claim is supported.

The failed attempt was `missing-2`, candidate repeat 1. A provider HTTP stream
returned a read error before the final answer. It remains a failure in the primary
denominator and was not retried. After inspecting the error, a recorded resume
amendment continued the remaining cases. Timing and token summaries use completed
turns only; quality rates include the failed attempt.

The `missing-1` control retains a song passage that names the same writers as the
removed whole-musical passage. Its wording has an ambiguous attachment, so it is
a test of claim scope, not a clean absence of answer names. With this case removed,
accurate insufficiency responses are 10/10 for baseline and 9/10 for the candidate;
the latter's only failure is the provider stream error. Among completed turns in
that subset, the results are 10/10 and 9/9. No robust abstention improvement is shown.

## Native-language chat detail

Each language has only two distinct questions and two repeats per condition.
The source/input languages are native; this is not a test of seven UI locales.
The app supports English and Chinese account locales. The runner selected Chinese
for Chinese questions and English otherwise, then restored the original locale.
Models sometimes replied in the question's language despite the English setting.

| Input/source language | Baseline core answer | Candidate core answer | Baseline all-claim support | Candidate all-claim support |
| --- | ---: | ---: | ---: | ---: |
| en | 4/4 | 4/4 | 4/4 | 4/4 |
| de | 4/4 | 4/4 | 4/4 | 4/4 |
| es | 4/4 | 4/4 | 4/4 | 4/4 |
| fr | 4/4 | 4/4 | 3/4 | 3/4 |
| ja | 4/4 | 4/4 | 4/4 | 3/4 |
| ko | 4/4 | 4/4 | 3/4 | 4/4 |
| zh | 4/4 | 4/4 | 4/4 | 4/4 |

Cross-language core answers were 16/16 in each condition. Their eight pairs cover
English sources with German, Spanish and Chinese questions; German sources with
English and Spanish questions; Spanish sources with English questions; and
Chinese sources with English and German questions. All-claim support was 15/16
in each condition. HotpotQA core answers were 16/16 each, with all-claim support
13/16 for baseline and 16/16 for the candidate.

## What the answer review caught

Every final answer was reviewed by Codex against the rubric and the passages
actually returned by its tools. This was not an independent or blinded human
assessment. Correctness checks the requested core answer; support and citations
also check added factual details. The review records each case's reason.

Examples include an unsupported AD 192 after a source gave only a century;
uncertainty about Antioch's port dropped from an answer; a film genre absent from
the cited passages; and a statistic for ages 65 and older translated as over 65.
The candidate also omitted the citation connecting the Zapruder film to its plaza
in one repeat even though it retrieved both required passages.

Source errors require a separate caution. The Korean ampere material already
contains an electron count missing its power of ten, an inconsistent ampere-hour
statement, and an outdated definition date. Some answers repeated these faithfully.
From the [BIPM ampere definition](https://www.bipm.org/en/si-base-units/ampere), one
coulomb corresponds to about 6.24 × 10¹⁸ elementary charges, not about six. The
[BIPM SI definition](https://www.bipm.org/en/measurement-units) also dates the current
constant-based system to 20 May 2019. These malformed source values existed in
the downloaded benchmark passages; this run did not introduce them during parsing.

Other answers silently changed likely source typos, such as 105 cm to 105 mm.
Those corrections may be sensible, but the cited passage does not establish them.
They fail strict support. This explains why core-answer match, source fidelity,
and factual reliability of the whole response must remain separate measures.

## Implications and limits

Keep this set as an evaluation record. If these cases guide the next ranking or
prompt change, they become development data and need a fresh evaluation set.
The strongest next target is fusion ranking, with per-language and per-task checks
that preserve hybrid's successes. The usable-file-ID change has a direct tool
benefit, but this run does not demonstrate an improvement in core-answer accuracy.

The corpus is broader than the earlier fictional English identifier chains, but
all chat sources are still Wikipedia-derived. Many native questions are easy
lookups. This does not cover student lecture notes, long textbooks, scanned PDFs,
table layout, lost math notation during our own parsing, handwriting, collaboration,
or heavy concurrent traffic. Public-data familiarity is possible. No weight
training or embedding-model tuning occurred, and no setting was selected from
this evaluation's scores.

## Artifacts and verification

The VM retains sources, embeddings, original streams, tool evidence, frozen index
snapshots and execution plans under `/opt/capy-rag-curated-20260905/broad`.
`results.json` records source revisions, raw SHA-256 hashes and both freezes.
The completion audit checked all 144 unique attempts and conversation IDs, model
identities, per-turn workspace/variant attribution, recomputed evidence diagnostics,
and unchanged source/index content. The original curated raw runs are intact.

The retrieval metric self-check passed before execution. Ruff format and lint,
Python compilation and `git diff --check` passed for the new scripts. The root
`pnpm run fmt:py` command could not fetch Ruff due to an `UnknownIssuer` TLS error;
the existing cached Ruff completed formatting and linting. The earlier production
patch's 69 focused tests had already passed; no further production code changed.

The lab now uses its original retrieval command and baseline variant. Gateway and
retrieval health checks returned HTTP 200. Only the ingest worker was started for
this run and it was stopped after ingestion finished; parser services remained
stopped. All new data is retained for inspection. `results.json` records the
restored service state.
