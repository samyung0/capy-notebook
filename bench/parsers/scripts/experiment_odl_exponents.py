"""Restore scientific-notation exponents only from matching raised source glyphs.

This is a native PDF experiment. It does not infer units, footnotes or formulas.
Only a caret is inserted; all existing text, blocks and geometry are retained.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import re
import tempfile
import time
from dataclasses import asdict
from pathlib import Path

import pymupdf
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_native_text import source_text

SCIENTIFIC = re.compile(r"(?<![\w.])([+−-]?\d+(?:\.\d+)?\s*[×·]\s*10)$")


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def source_exponents(page):
    result = []
    for group in page.get_text(
        "rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT & ~pymupdf.TEXT_PRESERVE_IMAGES
    )["blocks"]:
        for line in group.get("lines", []):
            if abs(line["dir"][0] - 1) > 0.01 or abs(line["dir"][1]) > 0.01:
                continue
            prefix, spans = "", []
            for raw_span in line["spans"]:
                span = {**raw_span, "text": "".join(c["c"] for c in raw_span["chars"])}
                match = SCIENTIFIC.search(prefix)
                exponent = span["text"].strip()
                if span["flags"] & 1 and match and re.fullmatch(r"[+−-]?\d+", exponent):
                    selected = [span] + [s for end, s in spans if end > match.start()]
                    boxes = [s["bbox"] for s in selected]
                    result.append(
                        {
                            "base": match[1],
                            "exponent": exponent,
                            "bbox": [
                                min(b[0] for b in boxes),
                                min(b[1] for b in boxes),
                                max(b[2] for b in boxes),
                                max(b[3] for b in boxes),
                            ],
                            "source": match[1] + "^" + exponent,
                            "glyph_centers": [
                                [
                                    (c["bbox"][0] + c["bbox"][2]) / 2,
                                    (c["bbox"][1] + c["bbox"][3]) / 2,
                                ]
                                for s in selected
                                for c in s["chars"]
                                if not c["c"].isspace()
                            ],
                        }
                    )
                prefix += span["text"]
                spans.append((len(prefix), span))
    return result


def slots(block):
    for key in ["text", "table_body", "list_items"]:
        value = block.get(key)
        if isinstance(value, str):
            yield key, None, value
        elif isinstance(value, list):
            for i, item in enumerate(value):
                if isinstance(item, str):
                    yield key, i, item


def restore_exponents(blocks, pdf):
    revised, decisions = copy.deepcopy(blocks), []
    needed = {
        b["page_idx"]
        for b in blocks
        if any(re.search(r"[×·]\s*10\s*[+−\d-]", text) for _, _, text in slots(b))
        and len(b.get("bbox", [])) == 4
    }
    with pymupdf.open(pdf) as document:
        for page_index in sorted(needed):
            page = document[page_index]
            if page.rotation:
                continue
            groups = None
            for source in source_exponents(page):
                base = re.sub(r"\s+", "", source["base"])
                pattern = re.compile(
                    r"(?<![\w.])("
                    + r"\s*".join(map(re.escape, base))
                    + r")\s*("
                    + re.escape(source["exponent"])
                    + r")(?!\d)"
                )
                box = pymupdf.Rect(source["bbox"])
                matches = []
                for i, block in enumerate(revised):
                    if (
                        block.get("page_idx") != page_index
                        or len(block.get("bbox", [])) != 4
                    ):
                        continue
                    native_box = pymupdf.Rect(
                        block["bbox"][0] * page.rect.width / 1000,
                        block["bbox"][1] * page.rect.height / 1000,
                        block["bbox"][2] * page.rect.width / 1000,
                        block["bbox"][3] * page.rect.height / 1000,
                    )
                    # Symbol font boxes include descenders below the printed row.
                    if not native_box.contains(
                        pymupdf.Point((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2)
                    ):
                        continue
                    if not all(
                        native_box.contains(pymupdf.Point(center))
                        for center in source["glyph_centers"]
                    ):
                        continue
                    marked = re.compile(
                        r"\s*".join(map(re.escape, base))
                        + r"\s*\^\s*\{?\s*"
                        + re.escape(source["exponent"])
                        + r"(?!\d)"
                    )
                    if any(marked.search(text) for _, _, text in slots(block)):
                        continue
                    if groups is None:
                        groups = page.get_text(
                            "rawdict",
                            flags=pymupdf.TEXTFLAGS_RAWDICT
                            & ~pymupdf.TEXT_PRESERVE_IMAGES,
                        )["blocks"]
                    # A raised and an ordinary expression can flatten identically.
                    # Require unique source text too, including already-correct output.
                    if (
                        len(list(pattern.finditer(source_text(groups, native_box))))
                        != 1
                    ):
                        continue
                    for key, item, text in slots(block):
                        matches.extend(
                            (i, key, item, text, m) for m in pattern.finditer(text)
                        )
                if len(matches) != 1:
                    decisions.append(
                        {
                            "page": page_index + 1,
                            **source,
                            "status": "ambiguous_or_absent",
                            "matches": len(matches),
                        }
                    )
                    continue
                i, key, item, text, match = matches[0]
                position = match.start(2)
                value = text[:position] + "^" + text[position:]
                if item is None:
                    revised[i][key] = value
                else:
                    revised[i][key][item] = value
                decisions.append(
                    {
                        "page": page_index + 1,
                        **source,
                        "status": "restored",
                        "block": i,
                        "field": key,
                        "item": item,
                        "before": match[0],
                        "after": match[0][: position - match.start()]
                        + "^"
                        + match[0][position - match.start() :],
                    }
                )
    return revised, decisions


def check():
    with tempfile.TemporaryDirectory() as directory:
        pdf = Path(directory) / "exponents.pdf"
        document = pymupdf.open()
        page = document.new_page()
        base = "1.8 × 10"
        page.insert_text((40, 50), base, fontsize=12)
        page.insert_text(
            (40 + pymupdf.get_text_length(base, fontsize=12), 45), "9", fontsize=8
        )
        page.insert_text((40, 100), "1.8 × 109", fontsize=12)
        document.save(pdf)
        document.close()
        with pymupdf.open(pdf) as source:
            expressions = source_exponents(source[0])
            assert len(expressions) == 1
            expression = expressions[0]
            center_y = (expression["bbox"][1] + expression["bbox"][3]) / 2
            cutoff = (min(p[1] for p in expression["glyph_centers"]) + center_y) / 2
            clipped = [0, cutoff / source[0].rect.height * 1000, 1000, 1000]
        block = {"type": "text", "page_idx": 0, "bbox": [0, 0, 1000, 1000]}
        for text in ["1.8 × 10^9\n1.8 × 109", "1.8 × 109"]:
            original = [{**block, "text": text}]
            assert restore_exponents(original, pdf)[0] == original
            original = [{**block, "bbox": clipped, "text": text}]
            assert restore_exponents(original, pdf)[0] == original
        # A narrow source region positively identifies the raised expression.
        with pymupdf.open(pdf) as source:
            box = [0, 0, 1000, 75 / source[0].rect.height * 1000]
        original = [{**block, "bbox": box, "text": "1.8 × 109"}]
        restored, _ = restore_exponents(original, pdf)
        assert restored[0]["text"] == "1.8 × 10^9"
        assert restore_exponents(restored, pdf)[0] == restored
    print(
        "mixed ordinary/raised values abstain; uniquely positioned exponent is restored"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sources", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.check:
        check()
        return
    if not args.sources or not args.output:
        parser.error("--sources and --output are required")
    args.output.mkdir(parents=True, exist_ok=False)
    records = []
    for entry in read(args.sources)["entries"]:
        assert sha(entry["parsed_pdf"]) == entry["parsed_pdf_sha256"]
        assert sha(entry["content_list"]) == entry["content_sha256"]
        blocks = read(entry["content_list"])
        began = time.perf_counter()
        updated, decisions = restore_exponents(blocks, entry["parsed_pdf"])
        seconds = time.perf_counter() - began
        assert restore_exponents(updated, entry["parsed_pdf"])[0] == updated
        for before, after in zip(blocks, updated, strict=True):
            assert before.get("bbox") == after.get("bbox")
            assert before.get("page_idx") == after.get("page_idx")
            assert before.get("type") == after.get("type")
            # Independent invariant: removing inserted carets reproduces input exactly.
            for key, item, value in slots(before):
                actual = after[key] if item is None else after[key][item]
                assert actual.replace("^", "") == value.replace("^", "")
        _, chunks, _ = chunk_native_bounded(updated)
        target = args.output / entry["id"]
        save(target / "content_list.json", updated)
        save(
            target / "chunks.json",
            [{**asdict(c), "indexed_text": c.indexed_text()} for c in chunks],
        )
        save(target / "decisions.json", decisions)
        records.append(
            {
                "id": entry["id"],
                "pages": entry["pages"],
                "seconds": seconds,
                "restored": sum(d["status"] == "restored" for d in decisions),
                "abstained": sum(d["status"] != "restored" for d in decisions),
            }
        )
    save(
        args.output / "summary.json",
        {
            "script_sha256": sha(__file__),
            "sources_sha256": sha(args.sources),
            "records": records,
        },
    )
    print(json.dumps(records))


if __name__ == "__main__":
    main()
