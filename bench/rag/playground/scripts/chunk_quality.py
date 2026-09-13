"""Per-chunk extraction confidence from the source PDF, parser-agnostic.

For every indexed chunk of one workspace, compare its text with the text layer
of the pages it cites and score how much of it the source can vouch for. The
playground appends the score and reasons to passage headers so the agent has a
reason to call capture_page. This is an offline diagnostic; it changes no rows.

  uv run --with pymupdf==1.28.2 python bench/rag/playground/scripts/chunk_quality.py --target lab --workspace odl_eval_odl
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import statistics
import sys
import time
import unicodedata
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import LOCAL, REPO, PdfResolver, prepare_environment  # noqa: E402

_CJK = re.compile(r"[぀-ヿ㐀-鿿가-힯]")
_ROW = re.compile(r"^\s*\|?.*\|.*$")


def tokens(text: str) -> list[str]:
    """Words for spaced scripts and single characters for CJK runs, so a mixed
    page and a chunk in either script tokenize the same way."""
    text = unicodedata.normalize("NFKC", text).lower()
    text = re.sub(r"\[figure\]|\[table\]", " ", text)
    text = _CJK.sub(lambda m: f" {m.group(0)} ", text)
    return re.sub(r"[^\w]+", " ", text).split()


def recall(chunk: list[str], source: Counter) -> float:
    if not chunk:
        return 1.0
    counts = Counter(chunk)
    return sum(min(n, source[t]) for t, n in counts.items()) / len(chunk)


def table_consistency(text: str) -> float | None:
    rows = [line for line in text.splitlines() if _ROW.match(line) and line.count("|") >= 1]
    if len(rows) < 2:
        return None
    widths = Counter(line.count("|") for line in rows)
    return widths.most_common(1)[0][1] / len(rows)


def score_chunk(text: str, page_texts: list[str], coverage: float | None) -> dict:
    reasons, signals = [], {}
    text_layer = any(len(p.strip()) >= 40 for p in page_texts)
    signals["text_layer"] = text_layer
    chunk_tokens = tokens(text)
    source = Counter(t for p in page_texts for t in tokens(p))
    r = recall(chunk_tokens, source) if text_layer else None
    signals["recall"] = r
    consistency = table_consistency(text)
    signals["table_consistency"] = consistency
    signals["page_coverage"] = coverage
    if not text_layer:
        score = 0.35
        reasons.append("scanned page with no text layer; text comes from OCR")
    elif text.startswith("[Figure]") or r < 0.15:
        # Captions are generated prose; a continuation chunk of a long caption
        # has no prefix, so near-zero agreement is read the same way.
        score = min(r, 0.5)
        reasons.append("model-generated description, not source text")
    else:
        score = r
        if r < 0.85:
            reasons.append(f"chunk text differs from the source text layer (match {r:.2f})")
    if consistency is not None:
        score *= 0.5 + 0.5 * consistency
        if consistency < 0.8:
            reasons.append("table rows have uneven column counts")
    if coverage is not None and coverage < 0.7:
        reasons.append(f"part of this page's source text is missing from the index (coverage {coverage:.2f})")
        score = min(score, 0.7 + 0.3 * coverage)
    return {"score": round(score, 3), "reasons": reasons, "signals": signals}


async def run(target: str, workspace_id: str, output: Path) -> None:
    import pymupdf
    from pipeline.retrieval import store

    pool = await store.pool()
    async with pool.connection() as conn:
        cur = await conn.execute(
            "SELECT c.id, fc.file_id, f.name, c.chunk_idx, c.text, c.page_start, c.page_end "
            "FROM rag_chunks c JOIN rag_file_contents fc ON fc.content_id = c.content_id "
            "JOIN files f ON f.id = fc.file_id WHERE c.workspace_id = %s AND f.trashed_at IS NULL ORDER BY fc.file_id, c.chunk_idx",
            (workspace_id,),
        )
        rows = [dict(r) for r in await cur.fetchall()]
    resolver = PdfResolver(target)
    docs: dict[str, list[str]] = {}
    missing: dict[str, str] = {}
    for file_id in {r["file_id"] for r in rows}:
        try:
            with pymupdf.open(await resolver.path(file_id)) as doc:
                docs[file_id] = [page.get_text() for page in doc]
        except KeyError as exc:
            missing[file_id] = str(exc)
    # Page coverage: how much of each page's text layer any chunk on that page carries.
    page_tokens: dict[tuple[str, int], Counter] = {}
    for r in rows:
        if r["file_id"] in docs and r["page_start"]:
            for p in range(r["page_start"], (r["page_end"] or r["page_start"]) + 1):
                page_tokens.setdefault((r["file_id"], p), Counter()).update(tokens(r["text"]))
    coverage: dict[tuple[str, int], float] = {}
    for (file_id, p), have in page_tokens.items():
        if 1 <= p <= len(docs[file_id]):
            source = tokens(docs[file_id][p - 1])
            coverage[(file_id, p)] = recall(source, have) if source else 1.0
    chunks, pages = {}, {}
    for r in rows:
        if r["file_id"] in missing or not r["page_start"]:
            chunks[r["id"]] = {"score": None, "reasons": [missing.get(r["file_id"], "no page model")], "signals": {}}
            continue
        span = range(r["page_start"], (r["page_end"] or r["page_start"]) + 1)
        texts = [docs[r["file_id"]][p - 1] for p in span if 1 <= p <= len(docs[r["file_id"]])]
        covs = [coverage[(r["file_id"], p)] for p in span if (r["file_id"], p) in coverage]
        result = score_chunk(r["text"], texts, min(covs) if covs else None)
        result.update(file=r["name"], chunk_idx=r["chunk_idx"], pages=[span.start, span[-1]])
        chunks[r["id"]] = result
        for p in span:
            pages.setdefault(r["file_id"], {})[str(p)] = {"coverage": coverage.get((r["file_id"], p))}
    scored = [c["score"] for c in chunks.values() if c["score"] is not None]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        "target": target, "workspace_id": workspace_id, "generated_unix": time.time(),
        "summary": {
            "chunks": len(chunks), "scored": len(scored), "unscored_files": missing,
            "median": statistics.median(scored) if scored else None,
            "below_0.7": sum(s < 0.7 for s in scored), "below_0.5": sum(s < 0.5 for s in scored),
        },
        "chunks": chunks, "pages": pages,
    }, ensure_ascii=False, indent=1))
    reasons = Counter(reason.split(" (")[0] for c in chunks.values() for reason in c["reasons"])
    print(json.dumps({"chunks": len(chunks), "scored": len(scored), "median": statistics.median(scored) if scored else None,
                      "below_0.7": sum(s < 0.7 for s in scored), "reasons": reasons.most_common()}, ensure_ascii=False, indent=1))


def check() -> None:
    page = "Mean height 15 m. West 16 18 12 20. Total 120 120."
    good = score_chunk("Mean height 15 m. West 16 18", [page], 0.9)
    assert good["score"] > 0.95 and not good["reasons"], good
    scan = score_chunk("anything", [""], None)
    assert scan["score"] == 0.35 and "scanned" in scan["reasons"][0], scan
    garbled = score_chunk("ｍean heigh1 l5 rn wesf 1G", [page], 0.9)
    assert garbled["score"] < 0.6 and "differs" in garbled["reasons"][0], garbled
    table = score_chunk("a | b | c\n1 | 2 | 3\n4 | 5", [page + " a b c 1 2 3 4 5"], 0.9)
    assert table["signals"]["table_consistency"] == 2 / 3 and "uneven" in table["reasons"][0], table
    fig = score_chunk("[Figure] a graph of growth", [page], 0.9)
    assert fig["score"] <= 0.5 and "generated" in fig["reasons"][0]
    tail = score_chunk("- Icon of three silhouettes labeled staff", [page], 0.9)
    assert "generated" in tail["reasons"][0]
    assert tokens("光合作用 ATP") == list("光合作用") + ["atp"]
    mixed = score_chunk("Tian Qi, Harbin 150001", ["祁天1 哈尔滨工业大学计算学部 Tian Qi, Harbin 150001 摘要 随着全球化的加速发展跨语言信息"], 0.9)
    assert mixed["score"] == 1.0, mixed
    gap = score_chunk("Mean height 15 m", [page], 0.4)
    assert "missing from the index" in gap["reasons"][0] and gap["score"] < 0.9, gap
    print("chunk_quality checks passed")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", default="lab")
    parser.add_argument("--workspace")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.workspace:
        raise SystemExit("--workspace is required")
    prepare_environment(args.target)
    sys.path.insert(0, str(REPO / "pipeline"))
    asyncio.run(run(args.target, args.workspace, LOCAL / "quality" / f"{args.target}-{args.workspace}.json"))


if __name__ == "__main__":
    main()
