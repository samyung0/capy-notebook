# Qwen3 reranking over frozen retrieval candidates

Qwen3 reranking put the correct JLPT passage first for all five query variants,
including the original English and Japanese searches that current hybrid
retrieval missed. Across the retained multilingual held-out partition, direct
union reranking increased hits from 304/312 to 307/312 and mean nDCG@5 from
0.8267 to 0.8706. Dense retrieval alone found more labeled answers, 309/312,
with nDCG 0.8595. Reranking also introduced clear wrong-task mistakes in the
controlled French and Taiwan questions. These results support further testing
of a second ranking stage; they do not select a production policy.

All 704 authorized attempts succeeded, with no retries. Reported usage was
6,277,205 tokens, about CNY 3.14 at the documented gross list price. Actual
billing is unavailable. Union requests added 0.91 seconds median and 2.00
seconds p95 HTTP latency from the local machine. No production state changed.

## Plan fixed before provider calls

The user authorized Alibaba Beijing `qwen3-rerank` over the retained multilingual
and JLPT inputs. No production ranking, parsing, index or application settings
change. This experiment reuses 624 multilingual questions and five JLPT query
variants. The previous development/held-out partition is retained for reporting;
both partitions were already inspected. It is frozen evaluation, not new unseen
validation. Public MIRACL and fictional controlled questions remain separate
cohorts. Taiwan/Hong Kong have only the controlled sources.

Candidate pools are the current RRF top40, dense top40, and their underlying
dense40 plus lexical40 union, up to 80 distinct chunks. For each pool compare
its original ordering with Qwen3 reranking before final top5. The unreranked
union uses current RRF ordering without the top40 trim. Keep the current
four-per-file cap and overflow behavior, and record every output it changes.
Report candidate Hit/Recall separately from final Hit/Recall/nDCG/MRR@5.

Documents use exact retained indexed text, including section headings, in stable
chunk-ID order. The JLPT chunk's stale heading remains unchanged. No title
injection, heading correction, query-specific instruction or phrase rule.
Use the documented default English instruction, `Given a web search query,
retrieve relevant passages that answer the query.` All candidate scores are
requested. Record exact input hashes and candidate memberships before calls.

The official [API reference](https://help.aliyun.com/zh/model-studio/text-rerank-api)
specifies `POST /compatible-api/v1/reranks` on the supplied Beijing workspace
host, with top-level `model`, `query`, `documents`, `top_n`, and `instruct`.
The model ID is `qwen3-rerank`; the documentation does not provide an immutable
dated version for this API alias. Record the actual response model and schema.
The documented limits are 500 documents, 4,000 tokens per query/document and 120,000
tokens per request, counting the repeated query for every document. Oversized
input returns 400 rather than being silently truncated. Preserve text and record
any rejected input; do not shorten failed cases after inspecting relevance.

The API explicitly says scores are request-relative. Therefore smaller-pool
rankings obtained by filtering full-union scores are labeled shared-union-score
replays, not presumed equivalent to direct40-document API calls. Full-union
quality uses one direct request per query. A fixed paired subset adds direct
hybrid40 and dense40 requests for four multilingual questions per locale and
all five JLPT queries. The 32 multilingual probes use both retained splits and
cover natural/semantic, locator, paraphrase and cross-language forms according
to an outcome-independent hash rule. Report score/order/output agreement and
actual direct40 latency separately. Full-corpus replay latency is union-sized.

Expected calls: 629 full unions, 74 direct40 probes and one two-document schema
probe, 704 total. Hard limit 720 attempts including failed/schema attempts.
Use at most two concurrent requests, at least 0.5 seconds between starts, timeout
90 seconds, and no automatic retries. Persist an attempt marker before sending
and the raw response or bounded failure afterward. Authentication errors or five
failures stop the run. Any later continuation needs an explicit artifact;
failures remain part of coverage and cost reporting.

Official [Beijing rate limits](https://help.aliyun.com/zh/model-studio/rate-limit)
list 5,400 requests/minute and 5,000,000,000 tokens/minute, with possible equivalent
per-second enforcement. Actual account limits may differ. The
[Beijing pricing table](https://help.aliyun.com/zh/model-studio/model-pricing)
lists CNY 0.5 per million input tokens, output free, with conditional free quota.
Report provider-reported usage, request latency p50/p95, and gross list-price
estimate separately from actual billed cost, which is unavailable without
billing records. Never infer usage for responses that omit it.

No method or threshold is selected by this run. Report all fixed arms, gains and
losses per locale/task and the five JLPT targets individually. Inspect a bounded
gain sample and held-out losses against exact source texts, preserving original
labels and noting unjudged alternatives. Bootstrap by source family, retaining
related query variants together; the small controlled family count and previous
inspection limit generalization. No additional embedding calls are needed.

Private credentials are read from a mode 600 JSON file and used only to construct
request headers. They are never logged or included in command arguments. If
copied to VM scratch, remove the private copy after calls. Preserve request,
response, scoring and failure artifacts in the ignored run directory. This
runner uses isolated scratch resources and never application worker processes.

## Execution and measurement

The network plan and final executed runner were frozen at 08:07:51 UTC on
September 13. The two-document schema probe succeeded before the main run.
The main run lasted 422 seconds, from 08:08:38 to 08:15:40 UTC. The analysis
protocol and analyzer were separately frozen at 08:14:54, while calls were still
running and before relevance outcomes were computed or inspected. No condition,
threshold, query, label or instruction changed after outcomes.

The multilingual inputs are the 3,149 source records, 3,277 chunks and 624
questions from the [language-handling experiment](2026-09-13-multilingual-language-handling.md).
Its existing Qwen/Qwen3-Embedding-4B v1 vectors, 2,560 dimensions, exact cosine
ordering and PostgreSQL lexical candidates were reused without embedding calls.
Queries search their assigned document-locale pool, not a mixed-language corpus.
The current baseline uses RRF k=60, vector weight 1, lexical weight 0.5, and full
lexical weight 1 for qualifying all-term matches under the existing short-query
rule. Language-specific PostgreSQL configurations and CJK bigrams remain intact.

The five [JLPT diagnostic queries](2026-09-13-jlpt-lookup.md) reuse the original
indexed PDF chunks and frozen candidate ranks. A fresh read-only check during
this investigation confirmed that the target chunk's body, indexed text, stale
section path and page span still match the retained UAT snapshot exactly. Thus
the successful diagnostic does not depend on a subsequently repaired heading.

Each multilingual split contains 120 MIRACL questions and 192 controlled
questions. Six locales have 20 MIRACL and 24 controlled questions per split;
Taiwan and Hong Kong have 24 controlled questions each. The controlled questions
share four source families per split across translations and query forms. Their
wording and relevance labels are model-authored, not native-speaker-certified.
The reduced MIRACL pools include judged hard negatives; unjudged passages keep
zero relevance for official metrics. This is not the complete MIRACL benchmark.

Hit@5 means at least one labeled answer appears; Recall@5 is the fraction of
positive source labels recovered. nDCG@5 uses the retained grades and actual
passage positions. A repeated source record contributes relevance only once;
MIRACL passage IDs remain separate records even when from the same article.
MRR@5 is the reciprocal rank of the first positive. JLPT instead requires the
exact target chunk. Tables below average questions equally, unlike the prior
language experiment's category-balanced selection score. The older broad
benchmark score is not a current baseline.

All 704 responses were HTTP 200 and exposed `model: qwen3-rerank`, `results`
with document `index` and `relevance_score`, a request ID and `usage.total_tokens`.
No dated backend revision was returned. The actual alias is confirmed; its
weights cannot be proven immutable. There were no authentication, rate, length,
schema or transport failures and no retries. Every requested document received
a finite score. All text was preserved. The largest individual query/document
was 2,031 UTF-8 bytes; the largest request contained 66,589 bytes when counting
the repeated query. These byte counts are input audit data, not token estimates.

## Candidate coverage and overall results

Every positive label was already present in each 40-candidate pool for all 629
queries: candidate Recall@40 was 1.000 for both hybrid40 and dense40. The union
also had recall 1.000, with 40–76 candidates, mean 52.72. The larger union added
no labeled-answer coverage here. This limits what the experiment can establish
about candidate retrieval over a large corpus; it mainly tests ordering among
already recovered answers and distractors.

“40 replay” below filters the union response scores to the frozen hybrid40 or
dense40 membership. It is not a direct 40-document call for the full corpus.
Both replay arms had identical aggregate quality. The unreranked union had
identical final results to current hybrid40 for all multilingual questions.

| Retained partition | Arm | Hit@5 count | Recall@5 | nDCG@5 | MRR@5 |
| --- | --- | ---: | ---: | ---: | ---: |
| Development, 312 | Current hybrid40 / unreranked union | 300 | 0.8899 | 0.8289 | 0.8400 |
| Development, 312 | Dense40 | 306 | 0.9226 | 0.8686 | 0.8697 |
| Development, 312 | Direct union rerank | 301 | 0.9144 | 0.8795 | 0.8878 |
| Development, 312 | Hybrid40 union-score replay | 301 | 0.9144 | 0.8823 | 0.8916 |
| Development, 312 | Dense40 union-score replay | 301 | 0.9144 | 0.8823 | 0.8916 |
| Held out, 312 | Current hybrid40 / unreranked union | 304 | 0.9022 | 0.8267 | 0.8299 |
| Held out, 312 | Dense40 | 309 | 0.9252 | 0.8595 | 0.8701 |
| Held out, 312 | Direct union rerank | 307 | 0.9241 | 0.8706 | 0.8774 |
| Held out, 312 | Hybrid40 union-score replay | 308 | 0.9273 | 0.8739 | 0.8808 |
| Held out, 312 | Dense40 union-score replay | 308 | 0.9273 | 0.8739 | 0.8808 |

The following held-out cohort breakdown separates public sources from the
controlled examples. “40 replay” represents both separately evaluated arms.

| Cohort | Arm | Hits / questions | Recall@5 | nDCG@5 | MRR@5 |
| --- | --- | ---: | ---: | ---: | ---: |
| MIRACL | Current hybrid40 | 115/120 | 0.7708 | 0.7031 | 0.7550 |
| MIRACL | Dense40 | 117/120 | 0.8056 | 0.7706 | 0.8443 |
| MIRACL | Union rerank / 40 replay | 117/120 | 0.8194 | 0.7808 | 0.8331 |
| Controlled | Current hybrid40 | 189/192 | 0.9844 | 0.9039 | 0.8767 |
| Controlled | Dense40 | 192/192 | 1.0000 | 0.9150 | 0.8863 |
| Controlled | Direct union rerank | 190/192 | 0.9896 | 0.9267 | 0.9051 |
| Controlled | 40 replay | 191/192 | 0.9948 | 0.9322 | 0.9106 |

The analyzer exposes quality conditional on successful calls separately from
end-to-end metrics that score a failed call zero. Those values coincide in this
run because every call succeeded. Failure records would remain visible and be
excluded from paired ranking intervals rather than described as rank regressions.

## Locale and task differences

Each cell reports held-out hits and per-question mean nDCG@5. These small groups
are diagnostic strata, not evidence for choosing a separate fusion weight for
each language.

| Locale | Questions | Current hybrid40 | Dense40 | Direct union rerank | 40 replay |
| --- | ---: | ---: | ---: | ---: | ---: |
| English | 44 | 43 / 0.8392 | 43 / 0.8488 | 42 / 0.8748 | 42 / 0.8748 |
| Japanese | 44 | 44 / 0.8645 | 44 / 0.8877 | 44 / 0.9097 | 44 / 0.9097 |
| Korean | 44 | 44 / 0.8233 | 44 / 0.8558 | 43 / 0.8681 | 43 / 0.8681 |
| zh-CN | 44 | 43 / 0.8323 | 43 / 0.8812 | 44 / 0.8235 | 44 / 0.8351 |
| zh-TW | 24 | 24 / 0.9218 | 24 / 0.9484 | 23 / 0.9020 | 23 / 0.9067 |
| zh-HK | 24 | 24 / 0.8914 | 24 / 0.8606 | 24 / 0.9692 | 24 / 0.9692 |
| Spanish | 44 | 42 / 0.7709 | 43 / 0.8018 | 44 / 0.8628 | 44 / 0.8628 |
| French | 44 | 40 / 0.7430 | 44 / 0.8325 | 43 / 0.8136 | 44 / 0.8234 |

The differences by task are at least as relevant as locale. The controlled
semantic questions regress even though their cross-language and paraphrase
forms improve. Literal identifiers, contextual locators and orthographic forms
were already at the ceiling in this controlled set.

| Held-out task | Questions | Current hybrid40 hits / nDCG | Dense40 hits / nDCG | Union rerank hits / nDCG |
| --- | ---: | ---: | ---: | ---: |
| Natural semantic | 120 | 115 / 0.7031 | 117 / 0.7706 | 117 / 0.7808 |
| Controlled semantic | 32 | 32 / 0.9423 | 32 / 0.9103 | 30 / 0.7938 |
| Paraphrase | 32 | 32 / 0.8224 | 32 / 0.8431 | 32 / 0.8858 |
| Cross-language | 32 | 29 / 0.6589 | 32 / 0.7368 | 32 / 0.8806 |
| Identifier | 32 | 32 / 1.0000 | 32 / 1.0000 | 32 / 1.0000 |
| Contextual locator | 32 | 32 / 1.0000 | 32 / 1.0000 | 32 / 1.0000 |
| Orthographic | 32 | 32 / 1.0000 | 32 / 1.0000 | 32 / 1.0000 |

## Original JLPT section lookup

The target was present in every candidate pool. The table gives its rank before
final selection; values above five were misses. Every direct union, hybrid40
and dense40 rerank placed it first. Both replay arms also placed it first.

| Query | Current hybrid rank | Dense rank | Direct rerank rank, all three pools |
| --- | ---: | ---: | ---: |
| `question 10 reading comprehension passage N1` | 12 | 24 | 1 |
| `問題10 次の文章を読んで 読解` | 8 | 16 | 1 |
| `問題 10 次の文章を読んで` | 1 | 13 | 1 |
| `問題 10` | 2 | 19 | 1 |
| `シアノバクテリアと藻類による大気環境の変化と現代人による環境変化はどのように違うか` | 1 | 1 | 1 |

This is direct evidence that a general instruction and the existing text can
resolve this numbered-section lookup without a rule for the specific phrase.
It does not show that the embedding model is defective: the dense candidate
stage already recovered the passage, and the subject-matter query ranked it
first without reranking. The earlier heading/packing ablation remains separate
evidence about why semantic similarity alone can be unreliable for locators.

The per-file cap changed no multilingual top-five output. It did change JLPT
neighbor selection: all five unreranked unions, four reranked unions, two
current hybrid lists and two dense lists. For each direct or replay 40-document
rerank arm it changed one list. It never removed or demoted the reranked target
from first place. This corpus cannot establish the cap's effect on longer
multi-passage answers.

## Direct-call agreement, latency and usage

The fixed 37-query paired sample produced 74 direct 40-document calls. Every
one had exactly the same complete subset ordering as its union-score replay:
74/74 complete-order agreement, identical top five, and zero pairwise inversions.
This supports the replay interpretation on that sample; it does not override
the hosted API's request-relative score contract or establish equivalence for
all other questions. No full-corpus direct40 latency was measured.

| Request pool | Requests | Median HTTP latency | p95 HTTP latency | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Union, all evaluation questions | 629 | 0.911 s | 2.002 s | 13.095 s |
| Union, paired sample only | 37 | 0.933 s | 2.304 s | — |
| Hybrid40, paired sample | 37 | 0.961 s | 2.573 s | 3.090 s |
| Dense40, paired sample | 37 | 0.964 s | 2.550 s | 2.722 s |

Calls ran from the local macOS machine with two concurrent workers and global
start spacing. Measurements include HTTP/TLS, provider processing and response
transfer, but exclude queueing, deliberate pacing and first-stage retrieval.
The small paired sample showed no latency saving from 40-document requests.
These measurements are not production end-to-end chat latency or a provider
capacity test. Replay arms inherit union-sized request cost and latency.

All 704 responses reported usage, totaling 6,277,205 tokens, including the
53-token schema probe. At the linked Beijing list price the gross estimate is
CNY 3.1386025. Free quota, discounts and the actual charge are unknown; no
invoice or billing API was inspected. No embeddings, answer generation or
additional model variants were purchased in this experiment.

## Gains, losses and uncertainty

Against current hybrid, held-out direct union reranking gained eight labeled
hits and lost five, for a net gain of three. Exact candidate text was inspected
for all thirteen changes and the four largest additional nDCG losses. There
were 55 total nDCG losses; the remaining ordering losses were not individually
adjudicated. Labels were never changed after seeing outcomes.

Two lost hits are clear controlled-task mistakes. A Taiwan backup question
whose answer is 72 minutes lost its correct record; the union ranked a library
loan record with 37 minutes first. The hybrid40 replay instead put parcel
transport with 58 minutes first. A French scanning question whose answer is
65 minutes lost its record to seminar enrollment with 51 minutes. These are
closely matched distractors with the wrong task, not merely incomplete labels.

The other three lost hits are MIRACL cases where zero judgment does not prove
that the promoted evidence is wrong. For the English “most expensive Champagne”
question, the new first passage explicitly describes an auction record while
the gold passage introduces a prestige brand. For the English gastrointestinal
question, the promoted passage directly addresses the common condition but
lacks the query's US qualifier. For the Korean professional-wrestling origin
question, the promoted passage explicitly names the US origin while labeled
records discuss wrestling more broadly or a much later Japanese promotion.
These are label/scope ambiguities within the retained text, not independently
verified factual conclusions.

All three controlled hit gains were cross-language queries and returned the
exact matching task, subject and fictional time first. Natural-source gains
also need caution: the Chinese Amazon and Spanish economy examples put a
plausible unjudged answer first while retrieving a labeled answer lower; the
French Mediterranean example retrieves a labeled research-membership list
that explicitly includes non-coastal countries. A hit gain alone therefore
does not prove a better generated answer. The remaining English Bison and
French axioms gains likewise retain entity or answer-specificity ambiguity.

The additional ordering-loss inspection found a Japanese group-founding query
promoting a subsidiary's founding history, a French women's-rights query
switching country/organization scope, and Taiwan scanning/mainland parcel
questions promoting charging/backup records. The latter examples demonstrate
related-subject and wrong-task errors even when a positive remains in the top
five. Source-review packets preserve the exact texts and original labels.

The frozen analysis uses 2,000 source-family bootstrap draws, seed 20260913.
For natural questions, union reranking's nDCG gain over current hybrid is
0.0776, with a 95% percentile interval of [0.0252, 0.1282]; dense-only gains
0.0675, interval [0.0375, 0.0971]. The rerank-versus-dense difference is much
smaller, and no significance claim is made for it. Natural questions span 119
source families across 120 retained held-out questions.

Controlled questions have only four held-out source families after grouping
translations and query forms. Their union-rerank gain is 0.0228, interval
[-0.0187, 0.0761]; the 40 replay gain is 0.0283, interval [-0.0059, 0.0775].
These intervals are wide, and there is no multiple-comparison correction.
Previous inspection of the sources, authored templates, reduced candidate
pools, incomplete judgments and the lack of real regional-Chinese evaluation
prevent a broad language-level conclusion.

## Interpretation

Reranking is a promising candidate for the original section-lookup failure:
it recovered every diagnostic without parser changes or phrase rules. The
40-document candidate stages deserve further comparison because the wider
union added no gold coverage here and introduced one additional held-out miss
relative to the 40-score replay. That comparison should use direct calls and
broader candidate-recall cases before choosing a production pool size.

Dense-only retrieval has the strongest multilingual hit count in this retained
set, but it misses four of the five JLPT variants. Conversely, reranking improves
average ordering but sometimes promotes a related entity or the wrong task.
Neither a universal lexical-weight adjustment nor a blanket language-based
reranking policy follows from this evidence. Language-aware tokenization is
already part of the baseline; task form, identifiers, semantic scope and source
structure also matter. Taiwan/Hong Kong require real regional-language sources
and native review before treating the controlled differences as language effects.

A production decision should weigh the observed additional HTTP latency against
answer quality on broader real-material questions, including full-document and
mixed-language scopes, unjudged alternatives and candidate misses. No production
ranking strategy, model registry entry or fallback was selected in this run.

## Artifacts, verification and cleanup

The runnable files are
[`qwen3_rerank_eval.py`](../scripts/qwen3_rerank_eval.py) and
[`qwen3_rerank_analyze.py`](../scripts/qwen3_rerank_analyze.py). Raw inputs,
responses and receipts remain in the gitignored directory
`bench/rag/reports/local/2026-09-13-qwen3-reranking/`. It contains exact prepared
chunks/questions, 703 main payloads, the schema payload, all 704 attempt records,
3,848 scored rows, complete cohort/locale/task summaries, direct/replay agreement,
latency/usage, paired intervals, review packets and cleanup receipts.

| Frozen artifact | SHA-256 |
| --- | --- |
| Prepared inputs | `05b864f56bb4c6335ce04c9d1d38987d157d6788e0eceec898335ef3dd80f09a` |
| Main payloads | `7566538c0545dcc76485cd5830c8b20c5d48bdcb58bbe6e19860a74591ec4f6f` |
| Executed network runner | `695bf77af3701069efd5f9257b7ea610737b8355231de701f50ebb756e69c8a7` |
| Analysis runner | `86c05ce2854cc25039a4cd02eb15a1ccdd03ab8b80a3fd761939d1f6afacf254` |

The freeze records also retain source hashes, probe hash, exact instruction,
paired IDs, model alias and limits. The analyzer validates those hashes, exact
body/index membership, unique query/payload IDs, contiguous unique attempt
sequences and complete response schemas. All 624 current-baseline output lists
matched the earlier frozen run exactly. An independent agent reconstructed all
3,848 scored outputs and all four metrics directly from the 704 raw responses
and frozen memberships; every result matched within 1e-12. Its receipt is
`independent-verification.json`.

The executed runner used direct JSON writes, so it did not guarantee marker
crash durability. This run had no observed crash; every retained record was
complete, unique and hash-matched. After calls finished, the tracked runner was
amended for future runs to use atomic replacement plus file/directory fsync and
to require the exact validated schema-probe receipt before main calls. Its
future-code hash is recorded separately in `future-run-amendment.json`;
`qwen3_rerank_eval.py` in the raw directory preserves the actual executed bytes.
No paid call used the amended code. This distinction is deliberate, not a
retroactive claim that newer code produced the observed results.

Explicit Ruff formatting/checking of both scripts, compilation and the runner's
focused checks passed. Required root `pnpm fmt:py` passed with 126 files
unchanged. Analysis integrity and independent reconstruction passed. No test
suite or application runtime was added by this experiment.

The private working credential was deleted after calls; the original private
credential was subsequently removed by the parent agent. `cleanup.json`
preserves the earlier timestamped receipt and `cleanup-final.json` records that
both paths are absent. A scan found no credential value in retained artifacts.
HTTP ran locally, so no VM secret, database, container or worker was created.
Only benchmark scripts, this report and ignored evidence were added. No commit,
push, deployment, UAT index mutation or production setting change was made.
