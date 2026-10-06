"""Build pilot-run corpora from MinerU 4.0 output for arm B of the intake comparison.

Reads the zip that `mineru-kit parse --format zip` wrote (middle_json.json and
images/), maps its blocks onto Capy's content-list shape, and writes
`<run>/books/<id>/corpus.json` through the production chunker, figure records
and excerpt grouping exactly as the pilot's parse stage does. It also keeps the
run's manifest.json (the book records from lab/knowledge/books.json) and an
all-failed tags.json, so `knowledge_base_library.py publish` loads the excerpts
untagged ("a failed tag keeps its excerpt"). refinement.json carries no
furniture: MinerU drops running heads, footers and page numbers itself.

Heading levels: MinerU types every heading as level 2, so levels come from the
PDF outline (title and page match); a MinerU heading the outline does not know
(an example box, a definition box) nests one level under the current outline
heading. The book title block and page furniture are not headings.

    uv run --project pipeline --with pymupdf==1.28.2 python \\
        bench/rag/intake/scripts/mineru_corpus.py --run <run-dir> --book ahss4 \\
        --zip bench/rag/reports/local/2026-10-intake-eval/mineru/ahss4/out/ahss4.zip
"""

from __future__ import annotations

import argparse
import dataclasses
import hashlib
import json
import re
import sys
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "bench/rag/scripts"))
sys.path.insert(0, str(ROOT / "pipeline"))

import knowledge_base_pilot as pilot  # noqa: E402

PARSER_IDENTITY = "mineru-4.0.10-standard-vllm"
SKIP = {"header", "footer", "page_number"}
PAGE_FURNITURE_TITLE = {"doc_title"}


def span_text(content) -> str:
    """Flatten MinerU spans: inline equations become $...$, styles are dropped."""
    if isinstance(content, str):
        return content
    parts = []
    for span in content or []:
        kind = span.get("type")
        if kind == "equation_inline":
            parts.append(f"${span.get('content', '')}$")
        elif kind == "text":
            parts.append(span.get("content", ""))
        elif isinstance(span.get("content"), list):
            parts.append(span_text(span["content"]))
        else:
            raise pilot.PilotError(f"Unknown MinerU span type {kind!r}")
    return "".join(parts)


def norm_title(title: str) -> str:
    title = re.sub(r"^(chapter|part)\s+[\divxlc]+\s*[:.]?\s*", "", title.strip(), flags=re.I)
    title = re.sub(r"^[\d.]+\s+", "", title)
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


class Outline:
    """PDF outline entries for heading levels: (level, normalised title, 1-based page)."""

    def __init__(self, pdf: Path):
        import fitz

        with fitz.open(pdf) as doc:
            self.entries = [(lvl, norm_title(t), p) for lvl, t, p in doc.get_toc()]
        self.current = 0

    def level(self, title: str, page: int) -> int:
        key = norm_title(title)
        for lvl, entry, entry_page in self.entries:
            if entry == key and abs(entry_page - page) <= 1:
                self.current = lvl
                return lvl
        return (self.current or 0) + 1


def scaled(bbox) -> list[float]:
    if not (isinstance(bbox, list) and len(bbox) == 4):
        raise pilot.PilotError(f"MinerU block without a bbox: {bbox!r}")
    return [round(float(v) * 1000, 3) for v in bbox]


def convert(middle: dict, outline: Outline) -> tuple[list[dict], dict]:
    blocks: list[dict] = []
    counts: dict[str, int] = {}
    for page in middle["pages"]:
        page_idx = int(page["page_idx"])
        for block in sorted(page["blocks"], key=lambda b: b.get("index", 0)):
            kind = block["type"]
            counts[kind] = counts.get(kind, 0) + 1
            if kind in SKIP:
                continue
            common = {"_native_type": kind, "page_idx": page_idx, "bbox": scaled(block.get("bbox"))}
            if kind == "paragraph_title":
                text = span_text(block.get("content"))
                blocks.append({**common, "type": "text", "text": text, "text_level": outline.level(text, page_idx + 1)})
            elif kind in PAGE_FURNITURE_TITLE or kind in {"text", "page_footnote", "aside_text", "ref_text"}:
                text = span_text(block.get("content"))
                if text.strip():
                    blocks.append({**common, "type": "text", "text": text})
            elif kind == "equation":
                blocks.append({**common, "type": "equation", "text": f"$${block.get('content', '')}$$"})
            elif kind in {"table", "image", "chart"}:
                body = kind if kind != "chart" else "image"
                out = {**common, "type": body}
                captions, footnotes = [], []
                for part in block.get("content", []):
                    role = part.get("type", "")
                    if role.endswith("_body"):
                        out["bbox"] = scaled(part.get("bbox", block.get("bbox")))
                        if body == "table":
                            out["table_body"] = part.get("content", "")
                        else:
                            out["img_path"] = part.get("image_path", "")
                    elif role.endswith("_caption"):
                        captions.append(span_text(part.get("content")))
                    elif role.endswith("_footnote"):
                        footnotes.append(span_text(part.get("content")))
                    else:
                        raise pilot.PilotError(f"Unknown MinerU {kind} part {role!r}")
                if body == "table":
                    out["table_caption"], out["table_footnote"] = captions, footnotes
                else:
                    out["image_caption"], out["image_footnote"] = captions, footnotes
                blocks.append(out)
            else:
                raise pilot.PilotError(f"Unknown MinerU block type {kind!r} on page {page_idx + 1}")
    return blocks, counts


def build(run: Path, book_id: str, zip_path: Path, parse_seconds: float | None) -> dict:
    from pipeline.retrieval.chunking import CHUNKER_VERSION
    from pipeline.retrieval.indexing import content_hash

    manifest_books = {b["id"]: b for b in json.loads((ROOT / "lab/knowledge/books.json").read_text(encoding="utf-8"))["books"]}
    book = manifest_books[book_id]
    source = ROOT / book["pdf_path"]
    if pilot.sha_file(source) != book["sha256"]:
        raise pilot.PilotError(f"Source checksum mismatch: {book_id}")
    identity = pilot.book_identity(book)
    dest = run / "books" / book_id
    raw = dest / "parsed"
    raw.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(raw)
    (raw / "refinement.json").write_text(json.dumps({"furniture": []}), encoding="utf-8")
    middle = json.loads((raw / "middle_json.json").read_text(encoding="utf-8"))
    started = time.monotonic()
    blocks, counts = convert(middle, Outline(source))
    (raw / "content_list.json").write_text(json.dumps(blocks, ensure_ascii=False), encoding="utf-8")
    chunks = pilot.page_chunks(blocks, raw, source)
    if not chunks:
        raise pilot.PilotError(f"No chunks from {book_id}")
    encoded = []
    for index, chunk in enumerate(chunks):
        value = dataclasses.asdict(chunk)
        value.update(
            id=f"chk_{identity[:14]}_{index}",
            chunk_idx=index,
            indexed_text=chunk.indexed_text(),
            regions=[r.as_dict() for r in chunk.regions],
        )
        encoded.append(value)
    figures = pilot.figure_records(blocks, identity, book.get("figure_exclusions", []))
    figures = pilot.drawing_records(book, blocks, identity, figures)
    excerpts = pilot.build_excerpts(encoded, identity, figures)
    corpus = {
        "book": book,
        "source_id": identity,
        "content_hash": content_hash(chunks),
        "release_sha": PARSER_IDENTITY,
        "chunker_version": CHUNKER_VERSION,
        "artifact_key": f"mineru/{book['sha256']}.zip",
        "parser_fingerprint": hashlib.sha256(zip_path.read_bytes()).hexdigest(),
        "pages": int(middle["metadata"]["document"]["page_count"]),
        "chunks": encoded,
        "excerpts": excerpts,
        "figures": figures,
        "metrics": {
            "parse_seconds": parse_seconds,
            "chunk_seconds": time.monotonic() - started,
            "mineru_block_counts": counts,
        },
    }
    pilot.save_json(dest / "corpus.json", corpus)
    # Run files the loader reads. One run per book: topics.json names a single
    # subject, and the books span four subjects.
    pilot.save_json(run / "manifest.json", {"books": [book]})
    pilot.save_json(run / "topics.json", {"subject_id": book["subject_id"], "topics": []})
    pilot.save_json(
        run / "tags.json",
        {
            "tags": {},
            "review_items": [],
            "failed_tags": {e["id"]: "untagged by design" for e in excerpts},
            "review_status": "untagged by design: arm B of the 2026-10-06 intake comparison",
            "batch_id": None,
            "model_transport": "none",
            "topics": [],
        },
    )
    return {
        "book": book_id,
        "pages": corpus["pages"],
        "blocks": len(blocks),
        "chunks": len(encoded),
        "excerpts": len(excerpts),
        "figures": len(figures),
        "block_counts": counts,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run", type=Path, required=True, help="this book's run directory to write")
    parser.add_argument("--book", required=True, help="book id from lab/knowledge/books.json")
    parser.add_argument("--zip", type=Path, required=True, help="MinerU zip output")
    parser.add_argument("--parse-seconds", type=float, help="wall time of the MinerU parse, for the metrics")
    args = parser.parse_args()
    print(json.dumps(build(args.run, args.book, args.zip, args.parse_seconds), ensure_ascii=False))


if __name__ == "__main__":
    main()
