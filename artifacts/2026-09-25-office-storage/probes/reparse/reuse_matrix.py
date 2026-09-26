"""Exact and whitespace-normalized vector reuse between cached parses.

Pairs are (published base, refreshed candidate). Exact = what index_file does
today (store.existing_file_vectors matches indexed_text exactly). Normalized =
the same match after collapsing whitespace runs, to size a cheap option.
"""

import json
import re
import sys
from pathlib import Path

sys.path.insert(0, r"C:\WEB\capy-notebook\pipeline")
from pipeline.retrieval.chunking import estimate_tokens
from pipeline.retrieval.confidence import ocr_pages, score_chunks
from pipeline.retrieval.headings import retain_headings
from pipeline.retrieval.packing import pack_blocks

probe = Path(sys.argv[1])
WS = re.compile(r"\s+")


def texts(name):
    path = probe / name
    result = json.loads(Path(str(path) + ".parsed.json").read_text(encoding="utf-8"))
    cl = result["content_list"]
    ev = result.get("_page_evidence")
    ch = pack_blocks(cl, frozenset(result.get("_furniture") or []))
    ch = retain_headings(cl, path, ch, verified=set(ev["visible_headings"]))
    score_chunks(ch, path, ocr=ocr_pages(cl), page_texts=ev["page_texts"])
    return [c.indexed_text() for c in ch], result.get("_page_count")


for base, cand in [p.split(":") for p in sys.argv[2:]]:
    a, pa = texts(base)
    b, pb = texts(cand)
    exact = set(a)
    norm = {WS.sub(" ", t).strip() for t in a}
    miss_exact = {t for t in b if t not in exact}
    miss_norm = {t for t in b if WS.sub(" ", t).strip() not in norm}
    total = sum(estimate_tokens(t) for t in b)
    print(
        json.dumps(
            {
                "base": base,
                "candidate": cand,
                "pages": [pa, pb],
                "chunks": len(b),
                "exact_reuse_pct": round(100 * sum(t in exact for t in b) / len(b), 1),
                "exact_embed_tokens": sum(estimate_tokens(t) for t in miss_exact),
                "normalized_reuse_pct": round(
                    100 * sum(WS.sub(" ", t).strip() in norm for t in b) / len(b), 1
                ),
                "normalized_embed_tokens": sum(estimate_tokens(t) for t in miss_norm),
                "all_chunk_tokens": total,
            }
        )
    )
