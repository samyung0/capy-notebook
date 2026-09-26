# qwen3.7-text-embedding vs Qwen3-Embedding-4B

Does Alibaba's hosted `qwen3.7-text-embedding` retrieve better than the
production embedder (`Qwen/Qwen3-Embedding-4B` on DeepInfra, 2560 dimensions)?
Findings: [reports/2026-09-25-qwen37-embedding.md](reports/2026-09-25-qwen37-embedding.md).

Two benchmarks, dense retrieval only unless noted:

- **Public**: the Sept 6 set (360 questions, 40 per MIRACL en/de/es/fr/ja/ko/zh,
  SciFact, ArguAna), rebuilt byte-identical with `broad/scripts/fetch_data.py`,
  chunked with the current chunker and ranked exactly in numpy with the Sept 6
  dense scoring (40 candidates, 4-per-file cap, top 5).
- **Library**: a read-only snapshot of 43 books of the live knowledge library
  (every multilingual book, all statistics books, a spread of English subjects),
  235 known-item queries written from chunk text before any retrieval
  ([fixtures/library-queries.json](fixtures/library-queries.json)), plus the 24
  frozen pilot questions. The production hybrid search is also run against a
  disposable local Postgres copy.

The live library is only ever read (`default_transaction_read_only=on`); the
4B document vectors are the stored ones. No production code is touched.

## Arms

| Arm | Documents | Queries |
| --- | --- | --- |
| `q4` | DeepInfra 4B, raw `indexed_text` (stored halfvec in the library) | production `Instruct: …\nQuery:` prefix |
| `q37` | Alibaba native endpoint, `text_type=document` | `text_type=query` |
| `q37i` | same | `text_type=query`, `instruct` = production task text |
| `q37c` | `text_type=query` (what the OpenAI-compatible route returns) | same |
| `…@1024` | first 1024 dimensions, renormalised | same |

`text_type` and `instruct` exist only on the native endpoint
(`/api/v1/services/embeddings/text-embedding/text-embedding`); the
OpenAI-compatible route embeds every input as a query.

## Reproduction

Keys come from the ignored `.env.local` (`DEEPINFRA_API_KEY`,
`ALIBABA_SINGAPORE_API_KEY`, `ALIBABA_SINGAPORE_BASE_URL`,
`LIBRARY_DATABASE_URL` through the SSH tunnel). Raw artifacts, the vector
cache and the request log go to the ignored `data/qwen37-embedding/`.
Every command runs from the repository root as
`uv run --no-sync --with numpy --with pyarrow python bench/rag/qwen37/scripts/<script>`
with `PYTHONUTF8=1` on Windows.

```sh
probe.py                               # API shapes, token accounting, batch limit
# public benchmark (9 GB of MIRACL corpus shards are scanned, then deletable)
python -c "import sys; sys.path.insert(0,'bench/rag/broad/scripts'); import fetch_data; from pathlib import Path; r=Path('data/qwen37-embedding/public'); fetch_data.beir(r); fetch_data.miracl(r)"
public_prepare.py
public_embed.py docs && public_embed.py docs-q && public_embed.py queries
public_eval.py dev                     # picks the qwen3.7 query handling
public_eval.py main
# library
library_snapshot.py                    # read-only; freeze before anything else
sample_targets.py                      # seeded candidates for query writing
freeze_queries.py                      # relevance sets + freeze hash, before retrieval
library_embed.py parity && library_embed.py docs && library_embed.py queries
library_eval.py
docker run -d --name qwen37-hybrid-scratch -e POSTGRES_PASSWORD=scratch -p 127.0.0.1:55437:5432 pgvector/pgvector:pg16
library_hybrid.py load q4 && library_hybrid.py load q37
library_hybrid.py search q4 && library_hybrid.py search q37 && library_hybrid.py search q37i
library_hybrid_eval.py
docker rm -f qwen37-hybrid-scratch
latency.py
report_tables.py                       # tables and spend for the report
```

Reruns reuse `vectors.sqlite3`; nothing already paid for is requested again.
The library snapshot and query fixture carry hashes in
`data/qwen37-embedding/library/{snapshot,queries-freeze}.json`; a republished
book changes chunk ids, so a rerun against a newer library needs a new
snapshot and new query labels, not a migration of these.
