# EmbeddingGemma 2 over the knowledge library

Is Google's 271M-parameter EmbeddingGemma 2, which can run locally, close to
the Qwen3-Embedding-4B we pay DeepInfra for? It reuses the
[rerank study](../rerank/README.md)'s frozen 43-book snapshot, its 360 labelled
questions, its 4B pools and its Qwen3-Reranker-4B scores. It adds Gemma vectors
and one reranker request per question over Gemma's top 40.
Findings: [reports/2026-10-11-embeddinggemma2.md](reports/2026-10-11-embeddinggemma2.md).

## Reproduction

`embed.py` needs its own environment: torch with CUDA,
`sentence-transformers>=6.1`, `transformers`, `pillow` and `psutil`. The model
downloads from Hugging Face on first use. `eval.py` runs in the pipeline
environment and reads `DEEPINFRA_API_KEY` from `.env.local`. It needs the rerank
study's ignored `data/rerank-eval/` and `data/qwen37-embedding/`.

```sh
python bench/rag/gemma2/scripts/embed.py queries   # GPU
python bench/rag/gemma2/scripts/embed.py docs      # GPU, ~16 min on an RTX 3060 Ti
python bench/rag/gemma2/scripts/embed.py cpu       # CPU query latency and document rate
PYTHONUTF8=1 uv run --no-sync --with numpy python bench/rag/gemma2/scripts/eval.py rerank
PYTHONUTF8=1 uv run --no-sync --with numpy python bench/rag/gemma2/scripts/eval.py analyze
```

`eval.py rerank` copies the rerank study's response cache into
`data/gemma2-eval/` and logs its requests there. A rerun bills nothing already
paid for.
