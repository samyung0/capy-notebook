"""Parse round DOCX files with the scratch parser and chunk them like ingest.

parse() caches the parser's multipart JSON next to the source. chunks_for()
replicates the ingest worker's Office path (pack_blocks, retain_headings,
score_chunks), the same calls the reparse probe used.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.chunking import Chunk, estimate_tokens
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

URL = "http://127.0.0.1:18393/file_parse"
HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
PROBE = HERE.parent / "probe"


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


def chunks_for(path: Path) -> list[Chunk]:
    result = parse(path)
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


def source(name: str) -> Path:
    """Round files live in work/, the reparse probe's variants in probe/."""
    for folder in (WORK, PROBE):
        path = folder / name
        if path.exists():
            return path
    raise FileNotFoundError(name)


if __name__ == "__main__":
    for name in sys.argv[1:]:
        path = source(name)
        t = time.perf_counter()
        chunks = chunks_for(path)
        print(
            json.dumps(
                {
                    "file": name,
                    "pages": parse(path).get("_page_count"),
                    "chunks": len(chunks),
                    "tokens": sum(estimate_tokens(c.indexed_text()) for c in chunks),
                    "s": round(time.perf_counter() - t, 1),
                }
            ),
            flush=True,
        )
