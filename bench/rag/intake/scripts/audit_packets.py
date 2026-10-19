"""Build the parser fidelity audit packets: one page image plus the texts under test.

For every page in `bench/rag/intake/fixtures/audit-pages.json` this renders the
PDF page (long edge 1568, like `capture_knowledge_page`) and collects the chunk
texts that cover it from arm B's MinerU corpus, from the live library's current
version (arms A and C) with `--live`, and from any builder run given as
`--run-side NAME=DIR` (`DIR/<book>/books/<book>/corpus.json`, e.g. a raw
current-parser parse with no review). Packets are what the
blind judge reads; a page's packet is updated in place, so the MinerU side can
be written before the tunnel to the live library is open.

    uv run --project pipeline --with pymupdf==1.28.2 python \\
        bench/rag/intake/scripts/audit_packets.py [--live] [--run-side raw_v15=DIR] [--book ahss4]
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
PAGES = ROOT / "bench/rag/intake/fixtures/audit-pages.json"
EVAL = ROOT / "bench/rag/reports/local/2026-10-intake-eval"
OUT = EVAL / "audit"
LONG_EDGE = 1568

LIVE_SQL = """
SELECT c.chunk_idx, c.section_path, c.text
FROM library_chunks c
JOIN library_book_versions v ON v.content_id = c.content_id
WHERE v.book_id = %s AND v.status = 'current' AND c.page_start <= %s AND c.page_end >= %s
ORDER BY c.chunk_idx
"""


def render(pdf: Path, page: int, target: Path) -> None:
    import fitz

    with fitz.open(pdf) as doc:
        p = doc[page - 1]
        scale = LONG_EDGE / max(p.rect.width, p.rect.height)
        p.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(target, output="jpeg", jpg_quality=85)


def corpus_texts(corpus: dict, page: int) -> list[dict]:
    return [
        {"chunk_idx": c["chunk_idx"], "section_path": c["section_path"], "text": c["text"]}
        for c in corpus["chunks"]
        if c["page_start"] <= page <= c["page_end"]
    ]


def live_texts(conn, book: str, page: int) -> list[dict]:
    rows = conn.execute(LIVE_SQL, (book, page, page)).fetchall()
    return [{"chunk_idx": r[0], "section_path": r[1], "text": r[2]} for r in rows]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument(
        "--live",
        action="store_true",
        help="fill the reviewed side from the live library: LIBRARY_DATABASE_URL in .env.local, reached through the tunnel on 15433",
    )
    parser.add_argument("--run-side", action="append", default=[], metavar="NAME=DIR", help="add side NAME from the builder run corpora under DIR")
    parser.add_argument("--book")
    args = parser.parse_args()
    run_sides = dict(item.split("=", 1) for item in args.run_side)
    sample = json.loads(PAGES.read_text(encoding="utf-8"))["books"]
    manifest = {b["id"]: b for b in json.loads((ROOT / "lab/knowledge/books.json").read_text(encoding="utf-8"))["books"]}
    conn = None
    if args.live:
        from urllib.parse import urlsplit, urlunsplit

        import psycopg
        from dotenv import dotenv_values

        url = dotenv_values(ROOT / ".env.local").get("LIBRARY_DATABASE_URL")
        if not url:
            raise SystemExit("LIBRARY_DATABASE_URL is not in .env.local")
        parts = urlsplit(url)
        credentials = f"{parts.username}:{parts.password}@" if parts.username else ""
        conn = psycopg.connect(urlunsplit(parts._replace(netloc=f"{credentials}127.0.0.1:15433")))
    index = []
    for book, entry in sample.items():
        if args.book and book != args.book:
            continue
        pdf = ROOT / manifest[book]["pdf_path"]
        corpus_path = EVAL / "mineru-run" / book / "books" / book / "corpus.json"
        corpus = json.loads(corpus_path.read_text(encoding="utf-8")) if corpus_path.exists() else None
        out = OUT / book
        out.mkdir(parents=True, exist_ok=True)
        for page in entry["sampled"]:
            packet_path = out / f"p{page:04d}.json"
            packet = json.loads(packet_path.read_text(encoding="utf-8")) if packet_path.exists() else {"book": book, "page": page, "texts": {}}
            image = out / f"p{page:04d}.jpg"
            if not image.exists():
                render(pdf, page, image)
            packet["image"] = str(image.relative_to(ROOT)).replace("\\", "/")
            # The judged MinerU side stays: the corpus on disk was rebuilt after the 10-07 verdicts.
            if corpus is not None and "mineru" not in packet["texts"]:
                packet["texts"]["mineru"] = corpus_texts(corpus, page)
            for name, run_dir in run_sides.items():
                side_corpus = json.loads((Path(run_dir) / book / "books" / book / "corpus.json").read_text(encoding="utf-8"))
                packet["texts"][name] = corpus_texts(side_corpus, page)
            if conn is not None:
                packet["texts"]["reviewed"] = live_texts(conn, book, page)
            packet_path.write_text(json.dumps(packet, ensure_ascii=False, indent=1) + "\n", encoding="utf-8", newline="\n")
            index.append({"book": book, "page": page, "sides": sorted(packet["texts"]), "packet": str(packet_path.relative_to(ROOT)).replace("\\", "/")})
    # The index covers every packet on disk, not only this run's books.
    index = []
    for packet_path in sorted(OUT.glob("*/p*.json")):
        if packet_path.name.endswith(".verdict.json"):
            continue
        packet = json.loads(packet_path.read_text(encoding="utf-8"))
        index.append({"book": packet["book"], "page": packet["page"], "sides": sorted(packet["texts"]), "packet": str(packet_path.relative_to(ROOT)).replace("\\", "/")})
    (OUT / "index.json").write_text(json.dumps(index, indent=1) + "\n", encoding="utf-8", newline="\n")
    done = {}
    for item in index:
        for side in item["sides"]:
            done[side] = done.get(side, 0) + 1
    print(json.dumps({"packets": len(index), "sides": done}))


if __name__ == "__main__":
    main()
