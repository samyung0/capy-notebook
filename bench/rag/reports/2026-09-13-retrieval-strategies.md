# Retrieval strategy comparison

## Frozen protocol

This comparison reuses the exact frozen multilingual query, chunk, vector and
PostgreSQL lexical results from the language-handling experiment. It makes no
embedding, reranking or other provider calls. The prior experiment's development
and held-out results have both already been inspected, so these labels preserve
source-family separation but do not represent a newly untouched evaluation.

The comparison is fixed before scoring:

- current RRF with `k=60`, dense weight 1, lexical weight 0.5 and full lexical
  weight only for the current two-to-three-term lookup qualification;
- dense-only ordering;
- equal-weight RRF;
- RRF with full lexical weight for every all-term match, with no term-count
  cutoff;
- one fixed convex score fusion with alpha 0.5 and theoretical min-max
  normalization. Cosine similarity uses its -1 lower bound and PostgreSQL
  `ts_rank_cd` uses 0. No alpha is tuned;
- current RRF with per-file cap 5 instead of 4 as an independent cap check.

All hybrid arms use the same union of the top 40 dense and top 40 lexical
candidates, then retain the top 40 ranked candidates before applying the output
cap and returning five. Compare hit, recall, MRR and nDCG at five by split,
locale and query category. Record relevant-source availability in the original
union and after each strategy's 40-candidate ranking. The known JLPT failure is
replayed separately and is diagnostic only.

The preregistered comparison does not test reranking, BM25, query rewriting,
late interaction, contextual embeddings, late chunking, parent expansion or
new parser output. Those need new model calls, indexes, document structure or
fixtures and cannot be inferred from a fusion replay.

## Results

The replay contains 312 development and 312 held-out questions. Current RRF
exactly reproduces every recorded baseline top-five list. The source family for
every judged relevant passage is available in both the original hybrid union and
the current fused top 40. On this fixture, candidate generation gives a reranker
the needed evidence; the loss occurs while selecting and ordering the final five.

| Split / method | Hit@5 | nDCG@5 | Recall@5 | Relevant-source recall after rank 40 |
| --- | ---: | ---: | ---: | ---: |
| Development / current RRF | 300/312 | .829 | .890 | 1.000 |
| Development / dense only | 306/312 | .869 | .923 | 1.000 |
| Development / equal RRF | 292/312 | .767 | .854 | 1.000 |
| Development / all-term RRF | 298/312 | .820 | .883 | 1.000 |
| Development / 50/50 score fusion | 278/312 | .733 | .793 | .993 |
| Held-out / current RRF | 304/312 | .827 | .902 | 1.000 |
| Held-out / dense only | 309/312 | .859 | .925 | 1.000 |
| Held-out / equal RRF | 299/312 | .766 | .874 | 1.000 |
| Held-out / all-term RRF | 303/312 | .823 | .900 | 1.000 |
| Held-out / 50/50 score fusion | 278/312 | .727 | .799 | .981 |

Dense-only has the best broad result. On held-out questions it gains five hits
over current RRF and loses none; on development it gains nine and loses three.
That is a serious reason to test dense as the first-stage ordering supplied to a
reranker. It is not enough to switch the product to dense-only. The controlled
locator and identifier questions are at ceiling for both methods, while the hard
JLPT locator is absent from dense top five. The synthetic fixture does not test
the structural lookup that triggered this investigation.

Held-out locale results are shown as hit count and nDCG@5:

| Locale | Current | Dense | Equal RRF | All-term RRF | Score fusion |
| --- | ---: | ---: | ---: | ---: | ---: |
| en | 43/44 · .839 | 43/44 · .849 | 43/44 · .796 | 42/44 · .823 | 41/44 · .759 |
| ja | 44/44 · .864 | 44/44 · .888 | 42/44 · .765 | 44/44 · .864 | 35/44 · .691 |
| ko | 44/44 · .823 | 44/44 · .856 | 42/44 · .768 | 44/44 · .823 | 35/44 · .639 |
| zh-CN | 43/44 · .832 | 43/44 · .881 | 42/44 · .731 | 43/44 · .832 | 41/44 · .699 |
| zh-TW | 24/24 · .922 | 24/24 · .948 | 24/24 · .880 | 24/24 · .922 | 24/24 · .948 |
| zh-HK | 24/24 · .891 | 24/24 · .861 | 24/24 · .871 | 24/24 · .891 | 24/24 · .922 |
| es | 42/44 · .771 | 43/44 · .802 | 43/44 · .722 | 42/44 · .767 | 43/44 · .731 |
| fr | 40/44 · .743 | 44/44 · .833 | 39/44 · .698 | 40/44 · .737 | 35/44 · .615 |

Held-out query-category results use the same notation:

| Category | Current | Dense | Equal RRF | All-term RRF | Score fusion |
| --- | ---: | ---: | ---: | ---: | ---: |
| Natural semantic | 115/120 · .703 | 117/120 · .771 | 111/120 · .633 | 114/120 · .694 | 98/120 · .480 |
| Semantic | 32/32 · .942 | 32/32 · .910 | 32/32 · .965 | 32/32 · .942 | 32/32 · 1.000 |
| Paraphrase | 32/32 · .822 | 32/32 · .843 | 32/32 · .635 | 32/32 · .822 | 32/32 · .889 |
| Identifier | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 |
| Contextual locator | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 |
| Orthographic | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 | 32/32 · 1.000 |
| Cross-language | 29/32 · .659 | 32/32 · .737 | 28/32 · .598 | 29/32 · .659 | 20/32 · .398 |

Equal lexical weight is unsupported. It loses five net held-out hits and eight
net development hits, with large drops on natural, paraphrase and cross-language
questions. Full weight for every all-term match rescues the known second JLPT
search, moving its target from rank 8 to rank 1. Across the multilingual fixture
it adds no hits, loses one held-out English hit and two development English hits,
and slightly lowers nDCG. This is exactly the result a known-failure diagnostic
can hide: a rule that fixes the motivating query but does not generalize.

The fixed 50/50 score fusion also performs poorly. It uses actual cosine scores
for every row in the frozen union, but the frozen source records retain
`ts_rank_cd` scores only for lexical top 40. The replay assigns zero lexical score
to other rows instead of recomputing their cover-density score. That censoring,
the untuned alpha, and the use of `ts_rank_cd` rather than BM25 mean this arm does
not rule out calibrated convex fusion. It only rejects this fixed replay.

Changing the per-file cap from four to five changes no top-five list or metric
across all 624 questions. Most fixture documents have one chunk, so this result
does not validate either cap for long PDFs. A useful cap fixture must label
several necessary continuations from one file alongside distracting files.
The cap also uses soft overflow, so it still returns same-file passages when
there are not enough alternatives.

### JLPT diagnostic

Target positions for the unchanged indexed passage are:

| Query | Current | Dense | Equal RRF | All-term RRF |
| --- | ---: | ---: | ---: | ---: |
| English question-10 locator | absent, rank 12 | absent, rank 24 | absent, rank 12 | absent, rank 12 |
| Japanese locator with `読解` | absent, rank 8 | absent, rank 16 | absent, rank 7 | 1 |
| Japanese locator without `読解` | 1 | absent, rank 13 | 4 | 1 |
| `問題 10` | 2 | absent, rank 19 | absent, rank 8 | 2 |
| Subject question | 1 | 1 | 1 | 1 |

The hard locator keeps lexical retrieval useful even though dense wins the broad
fixture. It also shows why a reranker should see current fused top 40 rather than
only the final five. The target is available at rank 8 and can still be recovered.

## Retrieval methods worth testing

The current lexical leg is PostgreSQL cover-density ranking, not BM25.
PostgreSQL documents that `ts_rank_cd` uses matching-term frequency, proximity
and field weights and does not use collection-wide statistics. BM25 adds inverse
document frequency, document-length normalization and term-frequency saturation.
Calling the current leg BM25 would blur a material difference. See the
[PostgreSQL text-search documentation](https://www.postgresql.org/docs/current/textsearch-controls.html).

RRF remains a sound zero-training baseline, but its `k` and leg weights are still
parameters. The original [RRF paper](https://doi.org/10.1145/1571941.1572114)
established rank fusion as a strong general method. Later work found that RRF can
be parameter-sensitive and that a learned convex score combination can beat it
when suitable labels and complete scores exist. See
[Bruch, Gai and Ingber](https://arxiv.org/abs/2210.11934). Our replay supports
testing calibrated fusion with complete scores; it does not support another
hand-set global weight.

The companion [Qwen3 experiment](2026-09-13-qwen3-reranking.md) now tests
reranking over these frozen candidates. It fixes all five JLPT lookups and
improves average ordering, while retaining some wrong-task regressions. Its
full-corpus 40-candidate results are shared-union-score replays, with direct
40-candidate calls on a fixed sample. A broader direct comparison of current
fused top 40 and dense top 40 remains useful. That targets the observed
final-five ordering loss and requires no new index. The
[Qwen3 technical report](https://arxiv.org/abs/2506.05176) describes the model
family's multilingual rerankers. Measure quality by locale and query category,
candidate survival, request tokens, latency and cost. Do not select it from the
aggregate alone; broader real locator fixtures still need to pass.

A separate structured-locator leg is the most direct candidate-generation test
for numbered sections, tables, figures, pages and identifiers. Index parser
structure into dedicated normalized fields and query those fields when the query
contains a locator. PostgreSQL already supports phrase queries and field weights.
This needs real multilingual PDF fixtures because the current controlled locator
set is at ceiling and the JLPT section path is stale.

Other methods solve different failures and should stay behind those two tests:

| Method | Failure it targets | Consequence here |
| --- | --- | --- |
| BM25 or learned sparse retrieval such as [SPLADE v2](https://arxiv.org/abs/2109.10086) | Weak lexical weighting and vocabulary mismatch | Requires a new lexical index and multilingual evaluation. It cannot be inferred from `ts_rank_cd`. |
| Query rewriting or [HyDE](https://arxiv.org/abs/2212.10496) | A short semantic query does not resemble the answer passage | Adds a model call and can drift away from exact section numbers. Test after reranking, using the original and rewritten query as separate legs. |
| [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | A chunk loses the document context needed to identify it | Adds generated context and re-embedding at ingest. It may help mixed or ambiguous chunks but needs source-faithfulness checks. |
| [Late Chunking](https://arxiv.org/abs/2409.04701) | Independently embedded chunks lose surrounding token context | Requires token-level states from a compatible long-context embedding model. The current hosted embedding API does not expose those states. |
| [ColBERTv2](https://arxiv.org/abs/2112.01488) late interaction | A single chunk vector compresses away useful token matches | Requires a multi-vector index and materially more storage and serving work. |
| Parent or neighbour expansion | A retrieved chunk omits needed continuation | Existing product decisions use `read_document` for continuation. Revisit only with measured incomplete-answer failures. |
| [RAPTOR](https://arxiv.org/abs/2401.18059) or GraphRAG | Broad synthesis or multi-hop questions spanning many passages | Adds hierarchy, summaries or a graph. The current incident is a single-passage locator failure, and existing decisions defer concept-graph retrieval until telemetry shows bridging failures. |

The practical order is a broader direct reranker comparison first, structured
locator second, then a complete BM25-versus-`ts_rank_cd` comparison. Query
generation, contextual embedding and new index families become worthwhile only
when a fixture shows the specific failure they claim to fix.

## Reproduction

From the repository root, use a new output directory:

```bash
python3 bench/rag/scripts/fusion_strategy_eval.py \
  --output /tmp/capy-retrieval-strategies-repeat
```

The runner checks SHA-256 hashes for every frozen source, verifies all 312
baseline records per split, reproduces every current top-five list, and refuses
to reuse an output directory. It uses only the Python standard library.

| Artifact | SHA-256 |
| --- | --- |
| Runner | `086e7b444c9a8f925a33176004b20d08712a3e2a9382a63262cedff81f59e9a8` |
| Complete 3,744-query-method result records | `0f009d0edc67328d77cce7866e461823519f7a36bc118c0fd71fcf3fee0b407e` |
| Summary, comparisons and JLPT replay | `86694c1e65ad87d428bcf91223e79e507efbbc9c2af8263e7a85e74d39614ede` |

Ignored results are under
`bench/rag/reports/local/2026-09-13-retrieval-strategies/`. No database,
provider call, application configuration or runtime code changed. An independent
replay under `/private/tmp/capy-fusion-review-20260913` produced byte-identical
result and summary files and passed the baseline reconstruction assertions.
