# EmbeddingGemma 2 against Qwen3-Embedding-4B, 11 October 2026

**Verdict: with the production reranker in front of it, EmbeddingGemma 2 is a
match for Qwen3-Embedding-4B on this library. On its own it is clearly worse.**
Over the 360 labelled questions of the [rerank study](../../rerank/reports/2026-09-25-library-rerank.md),
dense-only EmbeddingGemma 2 loses 0.060 MRR@10 to the 4B (0.821 vs 0.880,
95% interval −0.090 to −0.030). The loss is mostly on cross-lingual and
paraphrase questions. Followed by DeepInfra Qwen3-Reranker-4B over the first 20
candidates, which is what production does, the two models tie: 0.939 vs 0.940
(−0.001, −0.015 to +0.011). The hit@5 count is 3 won and 3 lost. Gemma's
first-stage recall is the same as the 4B's at 20 candidates and slightly higher
at 40 and 100. Gemma's first stage is weaker at ordering but finds the answer
just as often, and the reranker repairs the order.

The cost is CPU time if the model runs on a server. This PC's Ryzen 7 3700X
embeds a query in about 100 ms but documents at only 1 to 1.6 chunks per
second (float32, sentence-transformers, no ONNX or quantization).

## Setup

- **Model**: `google/embeddinggemma-2` (released 2026-10-06, Apache 2.0),
  loaded text-only through sentence-transformers 6.1 with the vision and audio
  encoders disabled. That is 271M parameters: a 130M transformer and a 140M
  embedding table, not 180M. It produces 768-dimensional vectors, with
  Matryoshka truncation to 512, 256 or 128. Documents use the model card's
  `title: none | text: ` prompt on each chunk's `indexed_text` (which already
  starts with the section path). Queries use `task: search result | query: `.
- **Corpus and labels**: the rerank study's frozen inputs, all unchanged. That
  is 43 books and 28,844 chunks (10.3M Gemma tokens). The 360 questions are 235
  known-item, 79 same-document and 46 near-miss. The 4B arms are that study's
  stored vectors and pools, reproduced exactly (asserted).
- **Arms**: exact cosine top 40 over halfvec-rounded vectors, folded the way
  `library.search` folds results, with excerpt-level metrics. For reranking,
  the 40 Gemma candidates went to DeepInfra Qwen3-Reranker-4B in chunk-id
  order, exactly as in the rerank study. "Top 20" reranks the first 20 and
  keeps the rest in dense order.
- **Not measured**: Gemma inside the production hybrid fusion (the lexical leg
  needs a Postgres copy). In the rerank study, hybrid and dense top 20 gave the
  same quality after reranking (0.941 and 0.940), because both draw on the same
  pool.

## Quality

| Arm | MRR@10 | hit@1 | hit@5 | nDCG@5 |
| --- | ---: | ---: | ---: | ---: |
| 4B hybrid, no rerank (production before 09-25) | 0.782 | 0.692 | 0.897 | 0.803 |
| 4B dense | 0.880 | 0.822 | 0.956 | 0.897 |
| Gemma 2 dense, 768d | 0.821 | 0.739 | 0.931 | 0.844 |
| Gemma 2 dense, 256d | 0.793 | 0.717 | 0.892 | 0.812 |
| 4B dense + rerank top 20 | 0.940 | 0.906 | 0.983 | 0.951 |
| 4B dense + rerank top 40 | 0.941 | 0.906 | 0.986 | 0.953 |
| **Gemma 2 dense + rerank top 20** | **0.939** | **0.903** | **0.983** | **0.950** |
| Gemma 2 dense + rerank top 40 | 0.946 | 0.911 | 0.992 | 0.958 |

MRR@10 by group:

| Arm | Mono EN (90) | Cross-lingual (96) | Paraphrase (40) | Mono non-EN (9) | Same-doc (79) | Near-miss (46) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 4B dense | 0.888 | 0.885 | 0.753 | 0.944 | 0.884 | 0.946 |
| Gemma 2 dense 768d | 0.852 | 0.805 | 0.635 | 0.926 | 0.856 | 0.870 |
| 4B dense + rerank top 20 | 0.943 | 0.941 | 0.892 | 1.000 | 0.926 | 0.989 |
| Gemma 2 dense + rerank top 20 | 0.954 | 0.935 | 0.896 | 1.000 | 0.925 | 0.967 |

Paired MRR@10 deltas (cohort-stratified bootstrap, 2,000 resamples):

| Pair | ΔMRR@10 | 95% CI | hit@5 won / lost |
| --- | ---: | --- | ---: |
| Gemma 768d vs 4B, dense | −0.060 | −0.090 to −0.030 | 7 / 16 |
| Gemma 256d vs Gemma 768d | −0.028 | −0.047 to −0.011 | 2 / 16 |
| Gemma vs 4B, both + rerank top 20 | −0.001 | −0.015 to +0.011 | 3 / 3 |
| Gemma vs 4B, both + rerank top 40 | +0.005 | −0.005 to +0.016 | 3 / 1 |

First-stage recall (a relevant excerpt among the first k chunks):

| Model | @10 | @20 | @40 | @100 |
| --- | ---: | ---: | ---: | ---: |
| 4B | 0.975 | 0.983 | 0.986 | 0.994 |
| Gemma 2 768d | 0.961 | 0.983 | 0.994 | 1.000 |
| Gemma 2 256d | 0.936 | 0.975 | 0.989 | 0.997 |

By query language (MRR@10, dense / reranked top 20). Small groups; read them as
direction only:

| Lang (n) | 4B dense | Gemma dense | 4B + rerank | Gemma + rerank |
| --- | ---: | ---: | ---: | ---: |
| en (231) | 0.878 | 0.826 | 0.938 | 0.943 |
| es (25) | 0.887 | 0.843 | 0.980 | 0.960 |
| zh-Hant (24) | 0.979 | 0.837 | 0.951 | 0.917 |
| zh-Hans (22) | 0.850 | 0.800 | 0.920 | 0.920 |
| ja (18) | 0.796 | 0.764 | 0.917 | 0.935 |
| fr (15) | 0.911 | 0.813 | 1.000 | 1.000 |
| de (13) | 0.817 | 0.885 | 0.923 | 0.923 |
| ko (12) | 0.917 | 0.702 | 0.896 | 0.847 |

Korean and Traditional Chinese questions are where Gemma stays behind even
after reranking (two and one excerpts lost from the top ranks). Given the group
sizes this is a pointer for a larger multilingual check, not a finding.

## Cost and speed

| | Qwen3-Embedding-4B (DeepInfra) | EmbeddingGemma 2 (self-hosted) |
| --- | --- | --- |
| Vector width / halfvec bytes | 2560 / 5,120 | 768 / 1,536 (256d: 512) |
| Query latency | p50 552 ms, p95 1,046 ms from this PC (qwen3.7 study) | p50 98 ms, p95 110 ms, 8 CPU threads; 104 / 117 ms at 4 |
| Document throughput | provider-bound | RTX 3060 Ti bf16: 29.7 chunks/s (whole library in 16 min); Ryzen 3700X fp32: 1.1 chunks/s at 4 threads, 1.6 at 8 |
| Money | $0.02 per 1M tokens (this library: roughly $0.2) | none beyond the host |
| Memory | none local | 2.3 GB process RSS on CPU (fp32, after the 200-chunk batch run) |

The CPU document rate is the catch. At 1.6 chunks per second, a 300-page book
(about 800 chunks) takes about 8 minutes of an 8-thread host, and the 43-book
subset would take about 5 hours. That is untuned float32 PyTorch.
ONNX/OpenVINO or int8 typically gives several times that, but this run did not
measure it. Queries are cheap enough for any host.

## What this means

- Swapping Gemma in **without** a reranker would be a regression. Its dense
  quality is about the old production hybrid level (0.821 vs 0.782 hybrid, 0.880
  4B dense).
- **With** the reranker production already runs over the first 20 candidates,
  the two are equivalent on this set, at 30% of the vector storage and no
  embedding bill. The quality burden moves to the reranker, which still costs
  money and network latency (p95 1.2 s for 20 documents in the rerank study).
- Do not truncate to 256d. It costs a further 0.028 dense MRR and some recall
  at 10 to 20.
- Before acting on this: test on the ingest host's actual CPU with an optimized
  runtime, run a larger Korean/Chinese/Japanese question set, and measure Gemma
  inside the hybrid fusion. A switch also means re-embedding every workspace
  and the library (new pin, new 768d vector table).

## Reproduction

See [the README](../README.md). Artifacts are in the ignored `data/gemma2-eval/`:
`docs.npy` and `queries.npy` (float32 768d), `timing.json`,
`scores-di-4b.json`, `requests.jsonl` (360 rerank requests, 6.39M tokens,
about $0.16), `results.json` (per-query records) and `tables.md`.
