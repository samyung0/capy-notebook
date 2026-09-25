"""Parse Office variants with the scratch parser container and compare chunks.

Replicates the ingest worker's Office path (worker._page_chunks) on the
parser's multipart response, then reports per variant how many chunks keep an
exact indexed_text of the baseline (the only vectors index_file reuses), the
estimated tokens that would be embedded, and the summary input size.
Usage: python parse_and_compare.py <baseline> <variant>... (files in probe/)
"""

import json
import sys
import time
from collections import Counter
from pathlib import Path

import requests

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval import indexing
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

URL = "http://127.0.0.1:18391/file_parse"
probe = Path(sys.argv[1]).parent


def parse(path: Path) -> dict:
    cache = path.with_suffix(path.suffix + ".parsed.json")
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    started = time.perf_counter()
    with path.open("rb") as fh:
        response = requests.post(
            URL,
            headers={"Authorization": "Bearer probe"},
            files={"file": (path.name, fh)},
            data={"filename": path.name},
            timeout=3600,
        )
    response.raise_for_status()
    result = response.json()
    result["_client_wall_s"] = round(time.perf_counter() - started, 2)
    result.pop("images", None)
    cache.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return result


def chunks_for(path: Path, result: dict):
    content_list = result["content_list"]
    evidence = result.get("_page_evidence")
    chunks = pack_blocks(content_list, frozenset(result.get("_furniture") or []))
    chunks = retain_headings(
        content_list, path, chunks, verified=set(evidence["visible_headings"])
    )
    score_chunks(
        chunks, path, ocr=ocr_pages(content_list), page_texts=evidence["page_texts"]
    )
    return chunks


def summarize(name: str, path: Path, base_texts: Counter | None, base_hash: str | None):
    result = parse(path)
    chunks = chunks_for(path, result)
    texts = [c.indexed_text() for c in chunks]
    tokens = [estimate_tokens(t) for t in texts]
    body = "\n\n".join(texts)
    row = {
        "variant": name,
        "pages": result.get("_page_count"),
        "ocr_pages": result.get("_ocr_page_count"),
        "server_parse_s": result.get("_server_parse_s"),
        "client_wall_s": result.get("_client_wall_s"),
        "chunks": len(chunks),
        "chunk_tokens": sum(tokens),
        "summary_input_tokens": estimate_tokens(body),
        "content_hash_changed": base_hash is not None
        and indexing.content_hash(chunks) != base_hash,
    }
    if base_texts is not None:
        unique_missing = {t for t in texts if t not in base_texts}
        row["reused_chunks"] = sum(1 for t in texts if t in base_texts)
        row["new_unique_texts"] = len(unique_missing)
        row["embed_tokens"] = sum(estimate_tokens(t) for t in unique_missing)
        row["reuse_pct"] = round(100 * row["reused_chunks"] / max(1, len(texts)), 1)
        # Where do the new chunks sit? (chunk index spread)
        idx = [i for i, t in enumerate(texts) if t not in base_texts]
        row["new_chunk_index_range"] = [min(idx), max(idx)] if idx else None
    return row, Counter(texts), indexing.content_hash(chunks)


baseline = Path(sys.argv[1])
row, base_texts, base_hash = summarize(baseline.name, baseline, None, None)
print(json.dumps(row))
for variant in sys.argv[2:]:
    path = Path(variant)
    row, _, _ = summarize(path.name, path, base_texts, base_hash)
    print(json.dumps(row))
