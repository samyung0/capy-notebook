# qwen3.7-text-embedding vs Qwen3-Embedding-4B, 25 September 2026

**Verdict: don't switch.** On the knowledge library, which is the target,
qwen3.7 is slightly ahead of the production embedder but not significantly.
Excerpt MRR@10 rises by +0.021 on dense retrieval (95% interval −0.007 to
+0.048) and by +0.011 through the production hybrid search (−0.012 to +0.033).
On the Sept 6 public benchmark it ties (nDCG@5 −0.002) and loses more hits
than it gains (6 new, 13 lost). The library gain sits in paraphrased and
cross-lingual queries, and Traditional Chinese goes the other way. Switching
has fixed costs that a gain this size does not cover: a new vector table and
pin, a native-endpoint client that carries document/query roles, a shared cap
of 1M tokens per minute, about 3.7 times the per-token bill, and no published
open weights.

| Arm | Public nDCG@5 | Public hits / 360 | Library MRR@10, dense | Library hit@10, dense | Library MRR@10, hybrid |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4B, 2560 (production) | 0.763 | 342 | 0.866 | 0.966 | 0.751 |
| qwen3.7, 2560 (primary) | 0.761 | 335 | 0.887 | 0.974 | 0.762 |
| qwen3.7 + instruct, 2560 | 0.764 | 334 | 0.894 | 0.979 | 0.763 |
| 4B truncated to 1024 | 0.757 | 340 | 0.879 | 0.966 | |
| qwen3.7 truncated to 1024 | 0.767 | 335 | 0.880 | 0.974 | |
| qwen3.7 via OpenAI-compatible route | 0.751 | 337 | | | |

Retrieval is exact cosine over halfvec-rounded vectors. The qwen3.7 primary
arm was fixed before the main runs: `text_type=document` for documents,
`text_type=query` for queries, no instruct (see [query handling](#query-handling)).
Intervals are cohort-stratified paired bootstraps with 2,000 resamples, as on
Sept 6.

## Public benchmark (the Sept 6 360 questions, dense)

The questions, qrels and pools are byte-identical to the Sept 5/6 inputs. The
freeze hashes match once line endings are normalised. The rebuilt 4B baseline
reproduces the Sept 5/6 dense arm: identical hits in all nine cohorts (342),
with nDCG@5 within 0.01 per cohort.

| Arm | Hits / 360 | nDCG@5 | Recall@20 | ΔnDCG@5 vs 4B | New / lost hits |
| --- | ---: | ---: | ---: | ---: | ---: |
| 4B, 2560 (production) | 342 | 0.763 | 0.986 | | |
| qwen3.7, 2560 | 335 | 0.761 | 0.983 | −0.002 (−0.020 to +0.015) | 6 / 13 |
| qwen3.7 + instruct, 2560 | 334 | 0.764 | 0.986 | +0.001 (−0.018 to +0.019) | 6 / 14 |
| 4B, 1024 | 340 | 0.757 | 0.986 | −0.006 (−0.015 to +0.003) | 1 / 3 |
| qwen3.7, 1024 | 335 | 0.767 | 0.982 | +0.004 (−0.014 to +0.023) | 6 / 13 |
| qwen3.7, documents embedded as queries (compat route) | 337 | 0.751 | 0.989 | −0.012 (−0.032 to +0.007) | 6 / 11 |

| Cohort (40 each) | 4B hits | 4B nDCG@5 | qwen3.7 hits | qwen3.7 nDCG@5 |
| --- | ---: | ---: | ---: | ---: |
| MIRACL English | 38 | 0.788 | 37 | 0.780 |
| MIRACL German | 37 | 0.728 | 40 | 0.796 |
| MIRACL Spanish | 39 | 0.728 | 40 | 0.742 |
| MIRACL French | 40 | 0.755 | 38 | 0.711 |
| MIRACL Japanese | 40 | 0.794 | 39 | 0.810 |
| MIRACL Korean | 39 | 0.762 | 38 | 0.790 |
| MIRACL Chinese | 37 | 0.746 | 36 | 0.714 |
| SciFact | 35 | 0.790 | 36 | 0.830 |
| ArguAna | 37 | 0.774 | 31 | 0.673 |

Six of the 13 lost hits are ArguAna. That task is counter-argument retrieval,
and the Sept 5 report already warned against letting it decide notebook search.
Leaving ArguAna out (post hoc) gives +0.010 (−0.007 to +0.028), which still
includes zero.

## Knowledge library (235 known-item queries, 28,844 chunks, dense)

The subset is 43 books, 36% of the 80,449 chunks eligible for plain library
search. It holds every book with non-English prose or non-Latin script, all
seven statistics books and 22 single-subject English books. The snapshot was
read once from the live library in a read-only session. The 4B document
vectors are the stored ones: re-embedding 64 seeded chunks the production way
gave cosine ≥ 0.9998 with the stored halfvec. The 235 queries were written
from chunk text and frozen (hash recorded) before either arm retrieved
anything. Near-copies (the same passage in two books) and two Spanish/English
translation pairs count as relevant.

Primary metric: excerpt-level MRR@10, because the excerpt is what
`search_knowledge` returns.

| Arm | MRR@10 | Hit@1 | Hit@5 | Hit@10 | ΔMRR@10 vs 4B | Hit@10 new / lost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4B, 2560 (stored vectors) | 0.866 | 0.804 | 0.945 | 0.966 | | |
| qwen3.7, 2560 | 0.887 | 0.830 | 0.953 | 0.974 | +0.021 (−0.007 to +0.048) | 4 / 2 |
| qwen3.7 + instruct, 2560 | 0.894 | 0.843 | 0.953 | 0.979 | +0.028 (+0.000 to +0.055) | 4 / 1 |
| 4B, 1024 | 0.879 | 0.830 | 0.945 | 0.966 | +0.013 (+0.002 to +0.025) | 3 / 3 |
| qwen3.7, 1024 | 0.880 | 0.821 | 0.957 | 0.974 | +0.014 (−0.012 to +0.041) | 4 / 2 |

| Query cohort | n | 4B MRR@10 | qwen3.7 MRR@10 | Δ (95% interval) |
| --- | ---: | ---: | ---: | ---: |
| Monolingual English | 90 | 0.888 | 0.897 | +0.009 (−0.029 to +0.046) |
| Paraphrase (key terms avoided) | 40 | 0.753 | 0.810 | +0.057 (−0.039 to +0.161) |
| Cross-lingual (zh, ja, ko, es, fr, de → English; English → Spanish) | 96 | 0.885 | 0.911 | +0.026 (−0.014 to +0.068) |
| Monolingual non-English (Spanish) | 9 | 0.944 | 0.889 | −0.056 (−0.167 to 0.000) |

Cross-lingual MRR@10 by query language, 4B → qwen3.7: Simplified Chinese
0.860 → 0.933 (n = 20), Traditional Chinese 0.975 → 0.917 (20), Japanese
0.830 → 0.821 (14), Spanish 0.873 → 0.887 (12), Korean 0.875 → 0.900 (8),
French 0.833 → 0.891 (8), German 0.812 → 1.000 (8).

Most changes are one-position swaps. The large moves are paraphrase queries
that describe a named method without naming it: Levene's test and the Holm
correction went from unranked to first. In the other direction, "area under
the bell curve … free online graphing calculator" (Desmos) went from first to
unranked. At chunk level the difference is similar: +0.018 (−0.011 to +0.045).

## Knowledge library through production hybrid search

`pipeline.retrieval.library.search` ran unchanged against a disposable local
Postgres copy of the same subset, one database per embedder, with query
vectors passed in (`vector=`). It used the production 40 fused candidates and
`top_k=10`, so the lexical leg, 0.5 lexical weight, exact-lookup rule,
verified-tag filter and excerpt folding are all production code. The numpy
dense ranking matched the pgvector ordering exactly (top 10 identical on
sampled queries).

| Arm | MRR@10 | Hit@1 | Hit@5 | Hit@10 | ΔMRR@10 vs 4B | Hit@10 new / lost |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4B | 0.751 | 0.655 | 0.868 | 0.953 | | |
| qwen3.7 | 0.762 | 0.668 | 0.868 | 0.966 | +0.011 (−0.012 to +0.033) | 5 / 2 |
| qwen3.7 + instruct | 0.763 | 0.672 | 0.885 | 0.957 | +0.011 (−0.012 to +0.033) | 5 / 4 |

MRR@10 by cohort, 4B → qwen3.7: monolingual English 0.839 → 0.838,
paraphrase 0.491 → 0.546 (+0.055, −0.009 to +0.120), cross-lingual
0.772 → 0.780, Spanish 0.819 → 0.778. The lexical leg is identical for both
arms, so the embedder gap shrinks to about half its dense size. On the pilot
questions, the top-5 overlap between arms rises from 3.5 to 3.8 of 5.

Hybrid ranks the target well below dense for both embedders: 4B MRR@10 is
0.751 hybrid vs 0.866 dense, and hit@1 is 0.655 vs 0.804. The drop is largest
on paraphrase queries (0.491 vs 0.753). These queries were written to avoid
the chunk's wording, which handicaps the lexical leg by construction, so this
is not a production-quality estimate. It is the same direction as the Sept 5
public result (hybrid 318/360 against dense 342/360).

## Pilot questions (secondary, topic labels only)

On the 24 frozen statistics pilot questions, both arms put on-topic excerpts
first. Topic precision@5 is 1.00 for 4B and 0.98 for qwen3.7, and the arms
share 3.5 of 5 top excerpts; the differences are orderings within the same
statistics books. Neither arm separates the two unanswerable questions by
content: both return biology or calculus excerpts. qwen3.7's cosine scale sits
higher. Median top-1 is 0.77 on answerable and 0.39 to 0.50 on unanswerable,
against 4B's 0.70 and 0.33 to 0.38, so any distance threshold would need
retuning.

## Query handling

The native endpoint (`/api/v1/services/embeddings/text-embedding/text-embedding`)
accepts `text_type` (`document`, the default, or `query`) and `instruct`,
which requires `text_type=query`. The OpenAI-compatible route accepts neither.
Its output was identical (cosine 1.0000) to native `text_type=query` on the
texts compared, so a compat integration silently embeds documents as queries.
That configuration is the weakest qwen3.7 row above. Document and query
vectors of the same text differ (cosine 0.86 to 0.99 over 26 texts). Outputs
are deterministic. Native `dimension=1024` equals the first 1,024 of the 2,560
dimensions renormalised (cosine 1.0000), so the 1024 rows show exactly what
the API returns at that width.

Before the main runs, the plain and instruct query shapes were compared on 60
held-out questions: 10 each from MIRACL es/ja/ko/zh, SciFact and ArguAna, next
in the Sept 5 seeded order. The decision rule was fixed in code (higher dev
nDCG@5, ties go to plain). Plain scored 0.749 and instruct 0.744 (4B 0.728),
so plain became primary. The instruct shape, using the production task text,
does slightly better on the library but was not the selected arm.

## Operational

| | Qwen3-Embedding-4B (DeepInfra) | qwen3.7-text-embedding (Alibaba, Singapore) |
| --- | --- | --- |
| Price per 1M input tokens | $0.02 | $0.07 |
| Billed tokens, 20,160 identical public chunks | 4,210,522 (208.9 per chunk) | 4,425,481 (219.5 per chunk, +5.1%) |
| Effective document cost | 1× | about 3.7× |
| Fixed overhead per input | ~1 token | ~15 tokens ("a" bills 17); `instruct` adds ~35 more |
| Tokens per library query | 51.0 (includes the production prefix) | 39.7 plain, 74.7 with instruct |
| Texts per request | 64 in production (CAPY_EMBEDDING_BATCH) | 20 maximum (HTTP 400 `InvalidParameter` at 21 on both routes) |
| Throttling seen | 0 errors in 435 requests. Bulk ran 4 concurrent 64-text batches at ~1.3M tokens/min | 188 × HTTP 429 `Throttling.AllocationQuota`, all recovered by backoff. Documented limit is 1,000,000 TPM and 24,000 RPM per primary account. Four concurrent 20-text batches crossed it within seconds. A client pacer at 0.9M tokens per rolling minute still drew 92 × 429 against 1,442 library batches, so the limiter smooths below a minute. Delivered 0.82M tokens/min, ~2,200 library chunks per minute |
| Single-query latency, dev PC, sequential, 50 calls, no retries | p50 552 ms, p95 1,046 ms, 0 errors | p50 338 ms, p95 377 ms, 0 errors |
| Burst: 32 single queries at concurrency 16 | 32/32 ok, no 429, p95 1.73 s | 32/32 ok, no 429, p95 1.88 s |
| Query/document roles | instruct prefix in the query text, OpenAI-compatible body | `text_type`, native endpoint only |
| Weights | open (Apache 2.0) | no open-weight release found |

Latency depends on where it is measured. Sept 6 measured DeepInfra 4B from
the ingest VM at p50 200 ms. The production token estimate
(`chunking.estimate_tokens`) over-counts public chunks by 15% against
DeepInfra's bill and 10% against Alibaba's. On library chunks it is within 3%
of Alibaba's bill (358 estimated vs 368 billed per chunk).

Adopting qwen3.7 would take more than a catalog row. `elitellm.embed_batch`
posts the OpenAI shape to DeepInfra only. qwen3.7 needs the native request
body (`input.texts`, `parameters.dimension`, `text_type`) and response
(`output.embeddings[].text_index`, `usage.total_tokens`), plus a
document/query role carried through `models.embed`, which today knows only
`format_query`. Ingest would need TPM-aware pacing: the cap is shared by every
environment on the ingest host and every key on the account. The workspace pin
rules mean existing workspaces stay on 4B. The library would move by
rebuilding into a new index: about $2.3 for the 88K current searchable chunks,
or $6.4 including retained versions.

## Caveats

- The library queries were written by an LLM (this agent) from sampled chunk
  text, before any retrieval, and may resemble either model's synthetic
  training queries. The labels are known-item: another passage may also
  answer, and an unlabeled answer counts as a miss for both arms. Templated
  look-alikes (other NumWorks procedures, other pilot landing tasks) were
  excluded by hand before retrieval.
- The subset covers 36% of the eligible library. The live library holds no
  Chinese, Japanese or Korean prose, so "cross-lingual" means non-English
  questions about English text. The monolingual non-English cohort is 9
  Spanish queries.
- The public benchmark is dense-only, with reduced MIRACL pools as on Sept 6.
  It uses the current chunker (v12, 19,776 chunks) instead of v5 (19,289), and
  exact ranking in numpy instead of SQL.
- The hybrid run searches the subset, not the whole library.
- Only the primary arm was pre-selected. The instruct and 1024-dimension rows
  are secondary, with no multiplicity correction. The 4B 1024-dimension
  library gain (+0.013) did not replicate on the public set (−0.006).

## Options

| Option | Quality evidence | Cost and work |
| --- | --- | --- |
| Keep 4B at 2560 (recommended) | Baseline | None |
| Move new workspaces and the library to qwen3.7 | Library +0.011 hybrid and +0.021 dense MRR@10, neither significant; public tie with more lost hits | New catalog row, vector table and allowlist entry in Go and Python; a native elitellm route with roles; TPM pacing in ingest; library rebuild (~$2.3); ~3.7× per-token spend; API-only model |
| Revisit if Chinese-language study becomes a priority | Simplified and Traditional Chinese disagree at n = 20 each | Native-speaker queries, a larger labelled set and hybrid on the whole library |

## Open questions

- Would real questions from Chinese-speaking learners show the Simplified
  Chinese gain or the Traditional Chinese loss?
- Will qwen3.7-text-embedding get an open-weight release? None was found on
  25 September 2026. The retrieval docs prefer open weights, so a dropped
  vendor model cannot strand pinned workspaces.
- On these known-item queries, hybrid ranks the target lower than dense for
  both embedders. Is that an artifact of wording-avoiding queries, or does it
  hold for real learner questions? It deserves its own measurement.
- Truncating 4B to 1024 dimensions was neutral on the public set and slightly
  positive on the library, and it cuts vector storage by 60%. It is out of
  scope here but cheap to test properly.

## Spend

| Provider | Requests | Errors | Billed tokens | Cost |
| --- | ---: | ---: | ---: | ---: |
| DeepInfra, Qwen3-Embedding-4B | 435 | 0 | 4,283,838 | $0.086 |
| Alibaba, qwen3.7-text-embedding | 3,926 | 190 (188 × 429, 2 × 400 batch probes) | 19,612,791 | $1.373 |
| Total | | | | $1.46 |

On Alibaba, library documents cost $0.744, public documents $0.310, and the
compat-mode public documents another $0.310. Queries, probes, latency and
burst tests cost under $0.01. Costs are logged usage times the published
price; provider invoices were not checked.

Artifacts: `data/qwen37-embedding/` (ignored). It holds the request log (no
text, no keys), the vector cache, the library snapshot with hashes, per-query
results and `summary.json`. Reproduction is in the [README](../README.md).
