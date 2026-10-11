"""Embed the frozen 43-book library and the 360 rerank-study queries with EmbeddingGemma 2.

Runs in its own environment (torch with CUDA, sentence-transformers >= 6.1,
pillow), not the pipeline's:

  python embed.py docs      # every snapshot chunk's indexed_text, GPU
  python embed.py queries   # the 360 study queries, GPU
  python embed.py cpu       # CPU timings at 4 and 8 threads (query latency, document throughput)

Text-only load (vision and audio encoders disabled), bfloat16 on GPU, float32
on CPU. Documents use the model card's untitled document prompt; the chunk's
indexed_text already starts with its section path. Queries use the
search-result query prompt. Vectors are stored full width (768) and
normalized; Matryoshka truncation happens in eval.py.

Output: data/gemma2-eval/docs.npy, queries.npy, queries.json, timing.json
"""

from __future__ import annotations

import gzip
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from sentence_transformers import SentenceTransformer

REPO = Path(__file__).resolve().parents[4]
SNAP = REPO / "data" / "qwen37-embedding" / "library"
OUT = REPO / "data" / "gemma2-eval"
OUT.mkdir(parents=True, exist_ok=True)
MODEL = "google/embeddinggemma-2"
DOC_PROMPT = "title: none | text: "
QUERY_PROMPT = "task: search result | query: "


def load(device: str) -> SentenceTransformer:
    dtype = torch.bfloat16 if device == "cuda" else torch.float32  # float16 gives NaNs per the model card
    model = SentenceTransformer(MODEL, device=device, model_kwargs={"torch_dtype": dtype},
                                config_kwargs={"vision_config": None, "audio_config": None})
    model.max_seq_length = 2048  # longest indexed_text is ~6k characters
    return model


def chunk_texts() -> list[str]:
    return [json.loads(s)["indexed_text"] for s in gzip.open(SNAP / "chunks.jsonl.gz", "rt", encoding="utf-8")]


def query_texts() -> list[dict]:
    """Same order as the rerank study's first_stage.queries()."""
    old = json.loads((REPO / "bench/rag/qwen37/fixtures/library-queries.json").read_text(encoding="utf-8"))["queries"]
    new = json.loads((REPO / "bench/rag/rerank/fixtures/cohorts.json").read_text(encoding="utf-8"))["queries"]
    return [{"id": q["id"], "query": q["query"]} for q in old + new]


def timing(update: dict) -> None:
    path = OUT / "timing.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
    path.write_text(json.dumps(data | update, indent=1) + "\n", encoding="utf-8")


def docs() -> None:
    model = load("cuda")
    texts = chunk_texts()
    torch.cuda.synchronize()
    started = time.perf_counter()
    vectors = model.encode([DOC_PROMPT + t for t in texts], batch_size=32, normalize_embeddings=True,
                           convert_to_numpy=True, show_progress_bar=True)
    torch.cuda.synchronize()
    seconds = time.perf_counter() - started
    assert np.isfinite(vectors).all()
    np.save(OUT / "docs.npy", vectors.astype(np.float32))
    tokens = sum(len(model.tokenizer(DOC_PROMPT + t)["input_ids"]) for t in texts)
    timing({"gpu_docs": {"device": torch.cuda.get_device_name(), "chunks": len(texts), "tokens": tokens,
                         "seconds": round(seconds, 1), "chunks_per_s": round(len(texts) / seconds, 1),
                         "peak_vram_mb": round(torch.cuda.max_memory_allocated() / 2**20)}})
    print(len(texts), "chunks in", round(seconds, 1), "s")


def queries() -> None:
    model = load("cuda")
    items = query_texts()
    vectors = model.encode([QUERY_PROMPT + q["query"] for q in items], batch_size=64, normalize_embeddings=True,
                           convert_to_numpy=True)
    np.save(OUT / "queries.npy", vectors.astype(np.float32))
    (OUT / "queries.json").write_text(json.dumps([q["id"] for q in items]) + "\n", encoding="utf-8")
    print(len(items), "queries")


def cpu() -> None:
    model = load("cpu")
    items = query_texts()[:100]
    texts = chunk_texts()
    sample = [texts[i] for i in range(0, len(texts), len(texts) // 200)][:200]
    out = {}
    for threads in (4, 8):
        torch.set_num_threads(threads)
        model.encode([QUERY_PROMPT + "warm up"])
        lat = []
        for q in items:
            started = time.perf_counter()
            model.encode([QUERY_PROMPT + q["query"]], normalize_embeddings=True)
            lat.append((time.perf_counter() - started) * 1000)
        started = time.perf_counter()
        model.encode([DOC_PROMPT + t for t in sample], batch_size=16, normalize_embeddings=True)
        doc_s = time.perf_counter() - started
        lat.sort()
        out[str(threads)] = {"query_ms_p50": round(lat[49], 1), "query_ms_p95": round(lat[94], 1),
                             "docs": len(sample), "docs_per_s": round(len(sample) / doc_s, 2)}
        print(threads, out[str(threads)])
    import psutil

    timing({"cpu": {"threads": out, "rss_mb": round(psutil.Process().memory_info().rss / 2**20)}})


if __name__ == "__main__":
    {"docs": docs, "queries": queries, "cpu": cpu}[sys.argv[1]]()
