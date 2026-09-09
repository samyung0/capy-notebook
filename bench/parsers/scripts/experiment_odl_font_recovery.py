"""Benchmark font-scoped PDF repairs; input PDFs and production stay unchanged."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
import unicodedata
from pathlib import Path


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def explicit_encoding(program: bytes) -> dict[int, str]:
    """Only the observed literal Type1 array, never execute PostScript."""
    header = program.split(b"currentfile eexec", 1)[0].decode("latin1")
    match = re.search(r"/Encoding 256 array\s+(.*?)readonly def", header, re.DOTALL)
    if not match:
        return {}
    body = match[1]
    if not re.match(r"0 1 255 \{1 index exch /\.notdef put\} for", body):
        return {}
    body = re.sub(r"^0 1 255 \{1 index exch /\.notdef put\} for", "", body)
    pairs = re.findall(r"dup (\d+) /([A-Za-z0-9_.]+) put", body)
    if re.sub(r"dup \d+ /[A-Za-z0-9_.]+ put", "", body).strip():
        return {}
    return {int(code): name for code, name in pairs}


def contradiction(encoding: dict[int, str], cmap: str) -> dict:
    """Narrow pilot gate: whole-byte CJK map contradicts explicit Latin glyphs."""
    ranges = re.findall(
        r"beginbfrange\s*<00>\s*<FF>\s*<([0-9a-fA-F]{4})>\s*endbfrange", cmap
    )
    base = int(ranges[0], 16) if len(ranges) == 1 else None
    latin = [
        (code, name)
        for code, name in encoding.items()
        if len(name) == 1 and name.isascii() and name.isalpha()
    ]
    return {
        "eligible": base is not None and 0x4E00 <= base <= 0x9EFF and len(latin) >= 8,
        "cmap_base": base,
        "latin_glyph_count": len(latin),
        "examples": [
            {
                "code": code,
                "glyph": name,
                "mapped": chr(base + code) if base is not None else None,
            }
            for code, name in latin[:8]
        ],
    }


def unicode_cmap(encoding: dict[int, str]) -> bytes:
    from pypdf._codecs import adobe_glyphs

    pairs = []
    for code, name in sorted(encoding.items()):
        text = adobe_glyphs.get("/" + name)
        if text is None:
            raise ValueError(f"embedded glyph has no Adobe Unicode mapping: {name}")
        # Expand presentation ligatures, preserving punctuation and all other glyphs.
        if text in "ﬀﬁﬂﬃﬄ":
            text = unicodedata.normalize("NFKC", text)
        pairs.append(f"<{code:02X}> <{text.encode('utf-16-be').hex().upper()}>")
    return (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CIDSystemInfo << /Registry (CapyBench) /Ordering (EmbeddedGlyphs) /Supplement 0 >> def\n"
        "/CMapName /EmbeddedGlyphs def /CMapType 2 def\n"
        "1 begincodespacerange <00> <FF> endcodespacerange\n"
        f"{len(pairs)} beginbfchar\n"
        + "\n".join(pairs)
        + "\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end\n"
    ).encode()


def audit(pdf: Path, target: Path) -> dict:
    import pymupdf

    started = time.monotonic()
    doc = pymupdf.open(pdf)
    fonts = {}
    page_fonts = []
    for page in doc:
        xrefs = sorted({font[0] for font in page.get_fonts(full=True)})
        page_fonts.append(xrefs)
        for xref in xrefs:
            if xref in fonts:
                continue
            name, extension, kind, program = doc.extract_font(xref)
            record = {
                "xref": xref,
                "name": name,
                "extension": extension,
                "type": kind,
                "eligible": False,
            }
            fonts[xref] = record
            if (
                kind != "Type1"
                or extension != "pfa"
                or doc.xref_get_key(xref, "Encoding")[0] != "null"
            ):
                record["reason"] = "outside explicit embedded Type1 encoding scope"
                continue
            encoding = explicit_encoding(program)
            unicode_key = doc.xref_get_key(xref, "ToUnicode")
            if not encoding or unicode_key[0] != "xref":
                record["reason"] = "no supported embedded encoding or ToUnicode"
                continue
            cmap_xref = int(unicode_key[1].split()[0])
            cmap_bytes = doc.xref_stream(cmap_xref)
            record.update(contradiction(encoding, cmap_bytes.decode("latin1")))
            record.update(
                cmap_xref=cmap_xref,
                program_sha256=digest(program),
                cmap_sha256=digest(cmap_bytes),
            )
            if record["eligible"]:
                record["encoding"] = encoding
                (target / f"font-{xref}-encoding.txt").write_text(
                    program.split(b"currentfile eexec", 1)[0].decode("latin1")
                )
                (target / f"font-{xref}-original-cmap.txt").write_bytes(cmap_bytes)
                (target / f"font-{xref}-rebuilt-cmap.txt").write_bytes(
                    unicode_cmap(encoding)
                )
    return {
        "source": str(pdf),
        "sha256": digest(pdf.read_bytes()),
        "pages": len(doc),
        "page_fonts": page_fonts,
        "fonts": list(fonts.values()),
        "seconds": time.monotonic() - started,
    }


def prepare(args: argparse.Namespace) -> None:
    import importlib.metadata

    import pymupdf

    args.output.mkdir(parents=True, exist_ok=False)
    manifest = json.loads((args.root / "corpus.json").read_text())
    entries = [entry for entry in manifest["entries"] if entry["suite"] == "full"]
    freeze = {
        "started_unix": time.time(),
        "script_sha256": digest(Path(__file__).read_bytes()),
        "source_checks_sha256": digest(args.checks.read_bytes()),
        "versions": {
            name: importlib.metadata.version(name)
            for name in ["pypdf", "PyMuPDF", "opendataloader-pdf"]
        },
        "strategy": "Only literal embedded Type1 glyph arrays with >=8 Latin glyphs and a contradictory whole-byte CJK ToUnicode map qualify. Compare removal and explicit cmap rebuild. Do not change fonts without independent mappings.",
        "entries": entries,
    }
    save(args.output / "frozen-run.json", freeze)
    (args.output / "source-checks.json").write_bytes(args.checks.read_bytes())
    (args.output / "runner.py.snapshot").write_bytes(Path(__file__).read_bytes())
    reports = []
    for entry in entries:
        target = args.output / entry["id"]
        target.mkdir()
        record = audit(args.root / entry["pdf"], target)
        assert record["sha256"] == entry["pdf_sha256"]
        save(target / "audit.json", record)
        reports.append(
            {
                "id": entry["id"],
                "pages": record["pages"],
                "seconds": record["seconds"],
                "eligible": [f["xref"] for f in record["fonts"] if f["eligible"]],
            }
        )
        doc = pymupdf.open(record["source"])
        pages = {
            "ccl-feedback": [1, 2, 7, 9],
            "nist-accelerometers": [2],
            "japan-migration": [10],
            "taln-complexity": [4],
            "hongkong-figures": [12],
        }.get(entry["id"], [])
        for index in pages:
            doc[index].get_pixmap(dpi=144).save(target / f"source-page-{index + 1}.png")
    save(args.output / "audit-summary.json", reports)
    print(json.dumps(reports), flush=True)


def convert(
    pdf: Path,
    target: Path,
    *,
    table_method: str = "cluster",
    include_header_footer: bool = True,
) -> dict:
    import pymupdf
    from compare_opendataloader import odl_content_list

    target.mkdir()
    command = [
        "opendataloader-pdf",
        str(pdf),
        "--output-dir",
        str(target),
        "--format",
        "json,markdown",
        "--image-output",
        "external",
        "--markdown-with-html",
        "--threads",
        "1",
    ]
    if table_method == "cluster":
        command.extend(["--table-method", "cluster"])
    elif table_method != "default":
        raise ValueError("unsupported table-method experiment")
    if include_header_footer:
        command.append("--include-header-footer")
    started = time.monotonic()
    with (target / "converter.log").open("w") as stream:
        subprocess.run(
            command, stdout=stream, stderr=subprocess.STDOUT, check=True, timeout=180
        )
    seconds = time.monotonic() - started
    doc = pymupdf.open(pdf)
    native = json.loads((target / f"{pdf.stem}.json").read_text())
    assert native["number of pages"] == len(doc)
    blocks = odl_content_list(
        native, [{"width": p.rect.width, "height": p.rect.height} for p in doc]
    )
    save(target / "content_list.json", blocks)
    result = {
        "seconds": seconds,
        "command": command,
        "pdf_sha256": digest(pdf.read_bytes()),
        "blocks": len(blocks),
    }
    save(target / "result.json", result)
    return result


def run(args: argparse.Namespace) -> None:
    import pymupdf

    assert not (args.output / "complete.json").exists()
    records = []
    for entry in json.loads((args.output / "frozen-run.json").read_text())["entries"]:
        target = args.output / entry["id"]
        evidence = json.loads((target / "audit.json").read_text())
        selected = [font for font in evidence["fonts"] if font["eligible"]]
        if not selected:
            records.append(
                {
                    "id": entry["id"],
                    "state": "unchanged",
                    "pages": entry["pages"],
                    "sha256": evidence["sha256"],
                }
            )
            continue
        source = args.root / entry["pdf"]
        records.append(
            {
                "id": entry["id"],
                "arm": "baseline",
                **convert(source, target / "baseline"),
            }
        )
        for strategy in ["drop-cmap", "rebuild-cmap"]:
            started = time.monotonic()
            doc = pymupdf.open(source)
            for font in selected:
                if strategy == "drop-cmap":
                    doc.xref_set_key(font["xref"], "ToUnicode", "null")
                else:
                    xref = doc.get_new_xref()
                    doc.update_object(xref, "<<>>")
                    doc.update_stream(
                        xref,
                        unicode_cmap({int(k): v for k, v in font["encoding"].items()}),
                    )
                    doc.xref_set_key(font["xref"], "ToUnicode", f"{xref} 0 R")
            candidate = target / f"{strategy}.pdf"
            doc.save(candidate)
            rewrite_seconds = time.monotonic() - started
            original = pymupdf.open(source)
            repaired = pymupdf.open(candidate)
            pixel_checks = []
            for index in range(len(original)):
                a = original[index].get_pixmap(dpi=144)
                b = repaired[index].get_pixmap(dpi=144)
                row = {
                    "source_page": index + 1,
                    "source_pixels_sha256": digest(a.samples),
                    "candidate_pixels_sha256": digest(b.samples),
                    "size": [a.width, a.height],
                }
                assert (a.width, a.height) == (b.width, b.height) and row[
                    "source_pixels_sha256"
                ] == row["candidate_pixels_sha256"]
                pixel_checks.append(row)
            save(target / f"{strategy}-pixel-checks.json", pixel_checks)
            record = {
                "id": entry["id"],
                "arm": strategy,
                "rewrite_seconds": rewrite_seconds,
                **convert(candidate, target / strategy),
            }
            records.append(record)
            print(json.dumps(record), flush=True)
    save(args.output / "complete.json", records)


def check() -> None:
    encoding = explicit_encoding(
        b"/Encoding 256 array\n0 1 255 {1 index exch /.notdef put} for\n"
        + b"\n".join(f"dup {ord(c)} /{c} put".encode() for c in "ABCDEFGH")
        + b"\nreadonly def currentfile eexec"
    )
    assert contradiction(encoding, "1 beginbfrange <00> <FF> <7500> endbfrange")[
        "eligible"
    ]
    assert not contradiction(encoding, "1 beginbfrange <00> <FF> <0000> endbfrange")[
        "eligible"
    ]
    assert not contradiction({65: "A"}, "1 beginbfrange <00> <FF> <7500> endbfrange")[
        "eligible"
    ]
    assert explicit_encoding(b"/Encoding StandardEncoding def") == {}
    assert explicit_encoding(b"/Encoding 256 array dangerous readonly def") == {}
    print("font contradiction checks passed")


def score(args: argparse.Namespace) -> None:
    """Replay the current production chunker against already frozen source checks."""
    from dataclasses import asdict

    from structured_recovery import chunk_content_list

    root = args.output / "ccl-feedback"
    checks = json.loads((args.output / "source-checks.json").read_text())
    table_page = next(
        page for page in checks["pages"] if page["id"] == "new-ccl-feedback-p4"
    )
    numeric_check = next(
        item for item in table_page["checks"] if item["id"] == "all-values"
    )
    expected = re.findall(r"\d{2}\.\d{3}", numeric_check["expected"])
    assert len(expected) == 64
    labels = ["Bare", "Edit", "EV", "GTs", "GP+Edit", "GP+EV", "Edit+EV", "GP+Edit+EV"]
    anchors = {
        2: [
            "Nagata",
            "INLG2022",
            "GenChal",
            "GPT-Neo",
            "BERT",
            "T5",
            "RoBERTa",
            "ICNALE",
            "EXPECT",
        ],
        7: [
            "GPT3.5-Turbo",
            "GPT4-Turbo",
            "mBART",
            "mT5",
            "BLEU",
            "BERTScore",
            "62.84",
            "59.27",
        ],
    }
    records = []
    packed = {}
    for arm in ["baseline", "drop-cmap", "rebuild-cmap"]:
        folder = root / arm
        content = json.loads((folder / "content_list.json").read_text())
        chunks = chunk_content_list(content)
        save(folder / "chunks.json", [asdict(chunk) for chunk in chunks])
        table_blocks = [
            block
            for block in content
            if block.get("page_idx") == 7
            and block.get("bbox", [0, 0, 0, 0])[1] >= 450
            and block.get("bbox", [0, 0, 0, 0])[3] <= 600
        ]
        values = re.findall(
            r"\d{2}\.\d{3}", " ".join(block.get("text", "") for block in table_blocks)
        )
        hits = []
        for row, label in enumerate(labels):
            sequence = label + "".join(expected[row * 8 : (row + 1) * 8])
            hits.append(
                {
                    "row": label,
                    "values": expected[row * 8 : (row + 1) * 8],
                    "chunk_indices": [
                        i
                        for i, chunk in enumerate(chunks)
                        if sequence in re.sub(r"\s+", "", chunk.text)
                    ],
                }
            )
        page_records = []
        for page in [1, 2, 7, 9]:
            blocks = [block for block in content if block.get("page_idx") == page]
            text = "\n\n".join(
                block.get(
                    "text",
                    block.get("table_body", "\n".join(block.get("list_items", []))),
                )
                for block in blocks
            )
            (folder / f"page-{page + 1}.txt").write_text(text, encoding="utf-8")
            page_chunks = [
                chunk
                for chunk in chunks
                if chunk.page_start is not None
                and chunk.page_start <= page + 1 <= chunk.page_end
            ]
            normalized = re.sub(
                r"\s+", "", "\n".join(chunk.text for chunk in page_chunks)
            )
            page_records.append(
                {
                    "source_page": page + 1,
                    "chunk_indices": [
                        i
                        for i, chunk in enumerate(chunks)
                        if chunk.page_start is not None
                        and chunk.page_start <= page + 1 <= chunk.page_end
                    ],
                    "anchors_in_final_chunks": {
                        word: word in normalized for word in anchors.get(page, [])
                    },
                }
            )
        records.append(
            {
                "arm": arm,
                "content_sha256": digest((folder / "content_list.json").read_bytes()),
                "chunks_sha256": digest((folder / "chunks.json").read_bytes()),
                "chunks": len(chunks),
                "table_values": values,
                "table_value_count": len(values),
                "all_64_in_order": values == expected,
                "rows_in_chunks": hits,
                "pages": page_records,
            }
        )
        packed[arm] = [asdict(chunk) for chunk in chunks]
    chunker = (
        Path(__file__).resolve().parents[3] / "pipeline/pipeline/retrieval/chunking.py"
    )
    save(
        args.output / "score.json",
        {
            "script_sha256": digest(Path(__file__).read_bytes()),
            "chunker_sha256": digest(chunker.read_bytes()),
            "drop_and_rebuild_chunks_identical": packed["drop-cmap"]
            == packed["rebuild-cmap"],
            "records": records,
        },
    )
    print(
        json.dumps(
            [
                {
                    key: record[key]
                    for key in ["arm", "chunks", "table_value_count", "all_64_in_order"]
                }
                for record in records
            ]
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["prepare", "run", "score", "check"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--checks", type=Path)
    arguments = parser.parse_args()
    if arguments.mode == "check":
        check()
    elif arguments.mode == "prepare":
        prepare(arguments)
    elif arguments.mode == "score":
        score(arguments)
    else:
        run(arguments)
