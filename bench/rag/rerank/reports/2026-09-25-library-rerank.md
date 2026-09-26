# Reranking knowledge-library search, 25 September 2026

**Verdict: add a reranker: DeepInfra `Qwen/Qwen3-Reranker-4B` over the first
20 fused candidates, after a latency check from the ingest host. By the
pre-registered rule the verdict is inconclusive, and only because of latency.**
Over the production candidates, the 4B raises excerpt MRR@10 from 0.782 to 0.941
(+0.159, 95% interval +0.129 to +0.191). It is also +0.061 above dense-only
ordering, loses no hit@5 against either baseline, and gains 32 against
production hybrid. Every cohort improves. The failure is the frozen latency
bar: a 40-document request's p95 from this PC is 2.0 s against the 1.5 s limit.
Reranking only the first 20 candidates is an exploratory variant. It gives the
same quality (0.941), a measured p95 of 1.2 s and costs about $0.0002 per
search. Alibaba `qwen3-rerank` and DeepInfra 8B are statistically tied with the
4B. The 8B has a multi-second latency tail at twice the price. Alibaba is the
fastest at 20 documents, but it promotes more wrong-task passages to rank 1.
The 0.6B is no better than dense.

Quality (360 queries: 235 existing known-item + 79 same-document + 46 near-miss;
excerpt level, which is what `search_knowledge` returns; intervals are paired
cohort-stratified bootstraps, 2,000 resamples):

| Arm | MRR@10 | hit@1 | hit@5 | nDCG@5 | ΔMRR vs hybrid | ΔMRR vs dense | hit@5 won / lost vs hybrid |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Hybrid (production) | 0.782 | 0.692 | 0.897 | 0.803 | | −0.099 (−0.127 to −0.070) | |
| Dense only | 0.880 | 0.822 | 0.956 | 0.897 | +0.099 (+0.070 to +0.127) | | 23 / 2 |
| Alibaba qwen3-rerank | 0.935 | 0.897 | 0.981 | 0.946 | +0.153 (+0.121 to +0.185) | +0.055 (+0.030 to +0.080) | 30 / 0 |
| Alibaba qwen3-rerank, learner instruction | 0.939 | 0.903 | 0.978 | 0.948 | +0.158 (+0.126 to +0.191) | +0.059 (+0.036 to +0.084) | 29 / 0 |
| DeepInfra Qwen3-Reranker-0.6B | 0.878 | 0.811 | 0.969 | 0.901 | +0.097 (+0.063 to +0.131) | −0.002 (−0.026 to +0.022) | 29 / 3 |
| **DeepInfra Qwen3-Reranker-4B** | **0.941** | **0.906** | **0.986** | **0.953** | **+0.159 (+0.129 to +0.191)** | **+0.061 (+0.039 to +0.085)** | **32 / 0** |
| DeepInfra Qwen3-Reranker-8B | 0.945 | 0.914 | 0.983 | 0.955 | +0.164 (+0.130 to +0.196) | +0.065 (+0.041 to +0.091) | 31 / 0 |
| 4B, first 20 candidates only (exploratory) | 0.941 | 0.906 | 0.983 | 0.952 | +0.159 (+0.129 to +0.191) | | |

MRR@10 / hit@1 by cohort:

| Arm | Mono EN (90) | Cross-lingual (96) | Paraphrase (40) | Mono ES (9) | Same-doc (79) | Near-miss (46) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Hybrid | 0.839 / 0.76 | 0.772 / 0.68 | 0.491 / 0.35 | 0.819 / 0.78 | 0.823 / 0.73 | 0.865 / 0.80 |
| Dense | 0.888 / 0.82 | 0.885 / 0.83 | 0.753 / 0.68 | 0.944 / 0.89 | 0.884 / 0.82 | 0.946 / 0.91 |
| Alibaba qwen3-rerank | 0.922 / 0.87 | 0.946 / 0.92 | 0.811 / 0.75 | 1.000 / 1.00 | 0.968 / 0.94 | 0.973 / 0.96 |
| DeepInfra 0.6B | 0.905 / 0.84 | 0.830 / 0.73 | 0.760 / 0.68 | 0.870 / 0.78 | 0.948 / 0.91 | 0.913 / 0.87 |
| DeepInfra 4B | 0.945 / 0.90 | 0.943 / 0.92 | 0.890 / 0.88 | 1.000 / 1.00 | 0.925 / 0.86 | 0.989 / 0.98 |
| DeepInfra 8B | 0.946 / 0.90 | 0.943 / 0.92 | 0.871 / 0.85 | 1.000 / 1.00 | 0.965 / 0.94 | 0.967 / 0.93 |

The 4B's gain over hybrid is significant in every cohort with more than nine
queries. Its largest gain is on paraphrase (+0.399), and it adds +0.107 even on
monolingual English. A book-cluster bootstrap gives nearly the same headline
interval (+0.125 to +0.190). At chunk level, counting the excerpt's displayed hit
chunk, the 4B goes from 0.708 to 0.885 (+0.177, +0.137 to +0.220).

## The first stage: hybrid and dense share one candidate pool

For every one of the 360 queries, the production fused top 40 contains exactly
the chunks of the dense top 40. At lexical weight 0.5 a lexical-only candidate
scores at most 0.5/61 = 0.0082, while the 40th vector candidate scores
1/(60+40) = 0.0100. Outside the exact-lookup tier (two or three content terms,
all matched), the lexical leg can therefore only reorder the vector top 40,
never add to it. The tier fired for none of these queries. The lexical leg
changed the order in 255 of 360 queries, and on these queries that reordering
costs 0.099 MRR@10 against pure dense ordering. The damage is worst on
cross-lingual questions in Latin-script languages (German 0.36 hybrid vs 0.81
dense, Spanish 0.61 vs 0.87) and on paraphrase. On the 235 existing queries the
baseline reproduces the qwen3.7 study exactly (hybrid 0.751, dense 0.866).

A reranker therefore sees the same 40 chunks whichever first stage feeds it.
Candidate recall is 355 of 360. The five misses are first-stage failures (two
cross-lingual, three paraphrase) that no reranker can fix. The 4B puts the
answer in the top 5 for all 355 in-pool queries. After reranking, the first
stage's order matters only for truncation: reranking the first 20 hybrid or
dense candidates gives the same quality (4B 0.941 and 0.940).

This finding changed the plan before any rerank call. The hybrid40, dense40 and
union arms collapse into one arm, so the Alibaba replay question disappears,
and the verification sample was re-specified. The change is recorded in
`fixtures/protocol-amendments.json` (09:19 UTC; the first study rerank request
ran after it).

## Regressions and their classification

The best arm (4B) loses **no** hit@5 against hybrid or against dense. The
nearest thing to lost hits is its 9 hit@1 demotions against hybrid. All 9 stay
in the top 5, at rank 2 or 4. I read each one against the exact chunk texts:

- **Label ambiguity, 8.** The promoted passage also answers, and several answer
  better. A typology section says which Papuan Malay processes are productive
  (mono_en-001). The opening of the *untuk* section mentions non-human
  beneficiaries explicitly (mono_en-002). A second chapter prints the same verb
  counts: 490 monovalent, 139 dynamic, 351 stative (samedoc-042). Fork copies
  in the other statistics book give the same rules or the same explanation
  (samedoc-046, samedoc-069, cross-040), and the R edition gives the same Q-Q
  plot explanation (cross-042). The ninth is the preceding chunk of the same
  section, listing the forms (mono_en-018).
- **Wrong-task promotion, 1.** Exercise 6.4's statement ranked above its
  solution when the question asked for the answer (samedoc-003). The solution
  is at rank 2.
- **True error, 0.**

Alibaba `qwen3-rerank` also loses no hit@5 against hybrid (1 against dense). Its
12 hit@1 demotions (all at ranks 2-4) split into 6 label ambiguity and 6
wrong-task promotions. The wrong-task cases are:

- the NumWorks two-proportion *test* steps above the *interval* steps;
- the R command for the t-test above its hypotheses;
- a different R/P/T/S exercise with the same template;
- the R edition's copy of the ANOVA worked example, whose numbers give a
  between-group SS of 3.45 when the question asks about 3.48;
- another aspect of the Milgram study;
- the na-marked-clause construction instead of the na-marked-element
  construction.

This is the September 13 failure class, a similar passage with the wrong task
or the wrong number. Here it causes six rank-1 demotions for Alibaba and one for
the 4B, and in no case does it push the answer out of the top 5.
The 0.6B loses 3 hit@5 and 28 hit@1 against hybrid, and it was not reviewed.

A known wrong passage (a labelled distractor) ranked above the answer:

| Cohort | Hybrid | Dense | Alibaba | 0.6B | 4B | 8B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Same-doc (79) | 5 | 3 | 2 | 3 | 3 | 2 |
| Near-miss (46) | 1 | 0 | 1 | 1 | 0 | 1 |

The new cohorts turned out easier than intended. Every reranker except the 0.6B
reaches hit@5 1.000 on both, and wrong-task base rates are low. The review also
found my own label errors, and each one counts against the rerankers. In
nearmiss-001 the labelled distractor (chunk 712) states the answer outright.
In samedoc-042 the counts appear in a second chapter. Several fork-book copies
answer but were not near-copies by text. Correcting these would raise the
reranked scores slightly and would not change the verdict.

The same-document cohort is where the 4B trails Alibaba and the 8B (0.925 vs
0.968 and 0.965). It misses rank 1 on 11 of the 79 questions, against 5 each
for them. Four of the 11 are the hit@1 losses above. On the other seven,
hybrid also missed rank 1. The 4B ranks the answer second to fourth behind a
fork copy, the explanatory section an exercise draws on, a sibling exercise or
table row, or a partial answer. One of these went from rank 2 to rank 4: os4's
true/false exercise on the same Twitter data (samedoc-018).

## Models and vendors

- **Scope.** Beijing serves `qwen3-rerank` on both the compatible and native
  routes. `qwen3.7-text-rerank` is documented (native route, ¥0.5/M, trained
  on the Qwen3.7 base), but the Beijing workspace answers 403 AccessDenied on
  both routes, and Singapore answers 404 "Model not exist". It could not be
  tested; enabling it is a console action. `gte-rerank-v2` still answers, but
  it is the older GTE model that Alibaba lists as discontinued on 2026-05-30.
  `qwen3-vl-rerank` is multimodal. Both were excluded.
- **Size.** 0.6B ties dense. 4B beats 0.6B by +0.063 (+0.040 to +0.085). 8B vs
  4B is +0.004 (−0.010 to +0.019), and 4B vs Alibaba is +0.006 (−0.010 to
  +0.023). On the existing queries the 4B leads Alibaba by +0.021 (+0.002 to
  +0.040); on the new cohorts Alibaba leads by 0.021 (−0.050 to +0.009).
- **Instruction.** On Alibaba the learner instruction is +0.005 MRR@10 (−0.008
  to +0.018) overall and +0.014 (−0.008 to +0.038) on the new cohorts. It
  bills 4.5% more tokens. DeepInfra accepts the `instruction` field but
  ignores it. Contradictory instructions ("state the colour" vs "state the
  weight") gave identical scores, and a six-times-longer instruction billed the
  same tokens. Alibaba honours it: the same probe flips its ranking.
- **Order and composition.** Alibaba's scores are pointwise in practice,
  whatever its documentation says about request-relative scores. The same
  documents in fused order, and the first 20 alone, gave scores within 6.7e-7
  of the chunk-id-order request in 50/50 queries. DeepInfra's scores move with
  document order by up to 0.055 (0.6B), 0.035 (4B) and 0.033 (8B). The complete
  order survived in 2, 34 and 6 of 50 requests, and the top 5 in 41, 49 and 44.
  The answer's rank was unchanged in 48, 50 and 50 of 50. Actual 20-document
  responses match the top-20 variant (computed from the 40-document scores) on
  the answer's rank in 49-50 of 50 queries per model.
- **Is Alibaba `qwen3-rerank` one of the open sizes? It cannot be determined.**
  Its scores are on a different scale: compressed, for example 0.98/0.24 where
  DeepInfra gives 0.99997/0.00005. Its orderings agree with each DeepInfra size
  less than the 4B and 8B agree with each other:

  | Pair | Spearman (median per query) | Same top 1 | Top-5 overlap |
  | --- | ---: | ---: | ---: |
  | Alibaba vs 0.6B | 0.780 | 68% | 3.62 |
  | Alibaba vs 4B | 0.792 | 78% | 3.73 |
  | Alibaba vs 8B | 0.793 | 79% | 3.74 |
  | 0.6B vs 4B | 0.788 | 69% | 3.55 |
  | 4B vs 8B | 0.868 | 81% | 3.93 |

  It behaves like the 4B/8B end of the family but matches neither. The cause
  could be different weights, a different prompt or quantization. The Beijing
  and Singapore deployments also return slightly different scores for the same
  input (0.2448 vs 0.2426).

## Latency, tokens and cost

These are sequential, uncached requests from the developer PC, interleaved
across models on the same 50 queries. The 40-document values are the frozen
first pass plus an exploratory uncached repeat. Dev-PC latency is not ingest-host
latency: DeepInfra embedding took 552 ms here against 200 ms from the VM.

| | 40 docs p50 / p95 (first pass, n=50) | 40 docs p50 / p95 (n=100) | 20 docs p50 / p95 (n=50) | Tokens per request, 40 (20) | List price per search, 40 (20) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Alibaba qwen3-rerank | 0.59 / 2.18 s | 0.61 / 2.06 s | 0.57 / 0.91 s | 17,582 (9,031) | ¥0.0088 ≈ $0.0012 (¥0.0045) |
| DeepInfra 0.6B | 0.71 / 1.15 s | 0.75 / 1.05 s | 0.61 / 1.24 s | 18,106 (9,291) | $0.00018 ($0.00009) |
| DeepInfra 4B | 1.30 / 2.01 s | 1.28 / 2.26 s | 0.82 / 1.20 s | 18,106 (9,291) | $0.00045 ($0.00023) |
| DeepInfra 8B | 1.74 / 11.66 s | 1.73 / 7.44 s | 1.21 / 3.07 s | 18,106 (9,291) | $0.00091 ($0.00046) |

The 8B has a multi-second tail in both passes (worst request 27 s, then 7.5 s).
DeepInfra bills a prompt template per document (about 13 tokens above Alibaba
per document). Every request to the four rerankers returned HTTP 200: 878
Alibaba, 1,557 DeepInfra, with no 429, timeout or retry. Alibaba runs were
limited to 2 concurrent requests and DeepInfra to 4.

Documented limits:
- **Alibaba qwen3-rerank:** 500 documents, 4,000 tokens per document and
  120,000 per request; oversize input is rejected, not truncated. The longest
  library chunk is 6,171 characters.
- **DeepInfra:** a 32,768-token context per query-document pair, with `queries`
  repeated once per document. The model page documents no per-request cap.

How many candidates to rerank (MRR@10, reranking the first k fused candidates
and keeping the rest in fused order):

| k | Hybrid recall@k | Alibaba | 0.6B | 4B | 8B |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 0.953 | 0.918 | 0.876 | 0.918 | 0.920 |
| 20 | 0.983 | 0.933 | 0.882 | 0.941 | 0.943 |
| 40 | 0.986 | 0.935 | 0.878 | 0.941 | 0.945 |

## Options

| Option | Quality (MRR@10, 360 queries) | Latency and cost | Work and risk |
| --- | --- | --- | --- |
| Keep hybrid | 0.782 | none | the lexical leg costs 0.099 on these queries |
| Dense order only, no reranker | 0.880 (+0.099) | none | drop the lexical leg in `library.search`; loses the exact-lookup tier for two- or three-term identifier searches, which never fired here |
| **DeepInfra 4B over the first 20 (recommended)** | 0.941 (+0.159; +0.061 over dense) | p95 1.2 s dev PC; ≈$0.0002 per search | existing vendor and key; a rerank call in `library.search` between the SQL rows and the fold; instruction field ignored; scores jitter slightly with order |
| Alibaba qwen3-rerank over the first 20 | 0.933 (+0.152) | p95 0.9 s dev PC; ¥0.0045 ≈ $0.0006 per search | new production vendor path; honours instructions; deterministic; more wrong-task promotions at rank 1 (6 vs 1) |
| DeepInfra 8B | 0.943-0.945 (tied with 4B) | p95 3-7 s tail; 2× 4B price | no measured gain for the tail |
| DeepInfra 0.6B | 0.878-0.882 (ties dense) | cheapest | no gain over the free dense option |

The recommended configuration comes from exploratory analysis: the 20-candidate
variant and the 20-document latency were not pre-registered. Its quality is
computed from the 40-document scores. The actual 20-document responses agree on
the answer's rank for 49 of 50 sample queries.

## Caveats

- **LLM-authored, known-item queries.** I wrote all 125 new queries from
  chunk text, before any retrieval. The 235 older queries were written the same
  way. Known-item labels miss passages that also answer, and the review found
  several. The new cohorts carry distinctive wording, and the rerankers solved
  them almost completely. Locator questions number only 8.
- **Real curate traffic is untested.** The queries are full questions. The
  curate agent often sends short role-and-topic searches, and those can
  trigger the exact-lookup tier.
- **Corpus scope.** The subset covers 43 books, 36% of the eligible library.
  The full library has more near-duplicates and more distractors, so candidate
  recall and reranker value could both differ. No CJK prose: cross-lingual
  means non-English questions about English text.
- **No workspace fixture.** There is no workspace or long-upload fixture. The
  same arithmetic applies to workspace `hybrid_search` (40 candidates, weight
  0.5), but workspace quality was not measured.
- **Latency location.** Latency comes from the developer PC, not the ingest
  host.
- **Price is list only.** Costs are list price times reported tokens; invoices
  and Alibaba's free quota were not checked. CNY is converted at 7.1 per USD.

## Open questions

- Latency of the DeepInfra 4B with 20 documents from the Netcup ingest host,
  where retrieval runs. That measurement settles the pre-registered bar.
- Should the reranker also apply to workspace `search_workspace` through the
  existing `_rerank` seam? Its candidate pool has the same structure.
- Without a reranker, should library search order by dense alone? That would
  cost the exact tier's identifier lookups, which need their own small test.
- Do the Alibaba wrong-task rank-1 promotions matter in the curate loop, where
  the agent reads several excerpts?
- `qwen3.7-text-rerank` needs Beijing console access before it can be compared.

## Spend

| Provider | Requests | Errors | Billed tokens | List cost |
| --- | ---: | ---: | ---: | ---: |
| Alibaba Beijing (qwen3-rerank; probes include the Singapore check) | 943 | 56 | 15,242,564 | ¥7.62 ≈ $1.07 |
| DeepInfra (three rerankers + 7,339 embedding tokens for the new queries) | 1,559 | 0 | 26,533,315 | $0.752 (DeepInfra's cost field: $0.7516) |

Caps were ¥30 and $3. All 56 Alibaba errors were unbilled 403/404 responses
from the unavailable `qwen3.7-text-rerank`. Six came from the probes. The other
50 were a runner mistake: the sample loop still listed that model. Main runs
cost ¥6.51 (the default and learner instructions, 360 requests each) and
$0.557. The order, latency and repeat passes cost ¥1.11 and $0.194.

## Method, artifacts and deviations

Order of work, all times UTC on 25 September:

1. The instructions were fixed at 08:24:44, before any rerank call. The only
   earlier provider calls were synthetic probes.
2. New-cohort candidates were nominated from corpus text by `families.py`:
   seeded look-alike families, and TF-IDF neighbours rather than the
   first-stage embeddings. I wrote the queries without any retrieval, and
   about one in five was assigned a non-English language by seed.
3. The queries, the relevance rule (near-copies decided explicitly) and the
   protocol were frozen at 08:53-08:54, with hashes in
   `data/rerank-eval/freeze.json`.
4. The first stage ran on a disposable pgvector copy of the snapshot. The
   copy's fold matched `library.search(top_k=10)` for all 360 queries, and its
   SQL vector ranks matched exact numpy ranks. The container and its volume
   were removed afterwards, and the live library was never contacted.

Deviations from the frozen protocol:
- The pool amendment described above.
- The 50 unbilled 403s.
- The exploratory 20-document latency, the uncached 40-document repeat and the
  top-k analysis.

Scripts, fixtures and reproduction are in the [README](../README.md). Raw
artifacts, including review packets with the exact texts of every lost and
gained hit, are in the ignored `data/rerank-eval/`.
