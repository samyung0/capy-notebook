# Cross-encoder reranking for knowledge-library search

Does a hosted Qwen3 cross-encoder, placed after first-stage retrieval, improve
`library.search`? Four rerankers are compared on the 43-book library subset
of the [qwen3.7 study](../qwen37/README.md): Alibaba Model Studio (Beijing)
`qwen3-rerank` and DeepInfra `Qwen/Qwen3-Reranker-0.6B`, `-4B` and `-8B`.
Findings: [reports/2026-09-25-library-rerank.md](reports/2026-09-25-library-rerank.md).

## Design

- **Corpus**: the frozen read-only snapshot of 43 books (28,844 eligible chunks)
  and their stored Qwen3-Embedding-4B vectors, from `data/qwen37-embedding/library/`.
  The live library is never contacted; hybrid search runs on a disposable
  local pgvector copy.
- **Queries**: the 235 frozen qwen3.7 known-item questions plus two new cohorts,
  [fixtures/cohorts.json](fixtures/cohorts.json), frozen before any retrieval:
  79 same-document competition questions (one chunk among look-alike
  siblings: numbered examples, exercise lists, parallel subsections, figure
  and exercise locators) and 46 near-miss questions (a related passage answers
  a different task, number or condition). 30 of the 125 are non-English.
- **Candidates**: production `store.hybrid_search` top 40 (its fold reproduces
  `library.search` exactly) and exact dense top 40. They turned out to be the
  same 40 chunks for every query, so each reranker scores one 40-document
  request per query ([amendment](fixtures/protocol-amendments.json)).
- **Instructions**: [fixtures/instructions.json](fixtures/instructions.json),
  fixed before any rerank call; the learner instruction runs on Alibaba only,
  because DeepInfra ignores the instruction field.
- **Protocol**: arms, metrics, bootstrap, best-model rule and verdict rule in
  [fixtures/protocol.json](fixtures/protocol.json), fixed before retrieval.

## Reproduction

Keys come from the ignored `.env.local` (`ALIBABA_API_KEY`, `ALIBABA_BASE_URL`,
`DEEPINFRA_API_KEY`; the Singapore pair only for the probe). Run from the
repository root as
`PYTHONUTF8=1 uv run --no-sync --with numpy python bench/rag/rerank/scripts/<script>`
(`families.py` also needs `--with scipy --with scikit-learn`).

```sh
probe.py base && probe.py instruct && probe.py singapore   # synthetic API probes
families.py                 # seeded candidates for the new cohorts (corpus text only)
freeze_cohorts.py check     # after writing fixtures/cohorts.json by hand
freeze_cohorts.py freeze
first_stage.py embed        # 4B vectors for the new queries
docker run -d --name rerank-eval-scratch -e POSTGRES_PASSWORD=scratch -p 127.0.0.1:55441:5432 pgvector/pgvector:pg16
first_stage.py load && first_stage.py pools
docker rm -fv rerank-eval-scratch
rerank_run.py union di-0.6b && rerank_run.py union di-4b && rerank_run.py union di-8b
rerank_run.py union ali-qwen3-rerank && rerank_run.py union ali-qwen3-rerank learner
rerank_run.py sample        # order/composition checks and latency, sequential
rerank_run.py latency       # exploratory: 20-document requests, uncached repeat of the 40
analyze.py                  # results.json, tables.md, review/*.md
```

Reruns read `data/rerank-eval/cache.sqlite3` and bill nothing already paid for
(the uncached latency repeat excepted). A republished book changes chunk ids,
so a run against a newer library needs a new snapshot and new labels.

## Artifacts

All under the ignored `data/rerank-eval/`: `requests.jsonl` (every provider
attempt: model, document count, usage, latency, status; no text or keys),
`cache.sqlite3` (scores), `query_vectors.sqlite3`, `candidates/`, `drafts/`
(query-writing notes), `freeze.json` and `cohorts-freeze.json` (hashes),
`pools.json` and `pools-check.json`, `scores/`, `sample.json`, `latency.json`,
`results.json`, `tables.md` and `review/` (exact texts of every lost and gained
hit and every known-wrong promotion).
