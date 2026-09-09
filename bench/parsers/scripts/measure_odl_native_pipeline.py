"""Measure fresh Java parsing with the tested native accuracy repairs.

Original PDFs stay unchanged. Captions, OCR, indexing and application queues are
outside this native-core comparison. Run arms sequentially in an idle VM.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import time
from dataclasses import asdict
from pathlib import Path

import pymupdf
from compare_opendataloader import Sampler, odl_content_list
from experiment_odl_font_recovery import audit, convert, unicode_cmap
from experiment_odl_native_tables import chunk_native_bounded
from experiment_odl_reading_order import demote_rotated, repair, split_continuations
from experiment_odl_source_styles import annotate
from structured_recovery import chunk_content_list


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def save(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--variant",
        choices=["baseline", "native", "extended", "refined"],
        required=True,
    )
    parser.add_argument(
        "--table-method", choices=["cluster", "default"], default="cluster"
    )
    parser.add_argument("--exclude-header-footer", action="store_true")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    entries = [
        row
        for row in json.loads((args.root / "corpus.json").read_text(encoding="utf-8"))[
            "entries"
        ]
        if row["suite"] == "full"
    ]
    if not entries or len({row["id"] for row in entries}) != len(entries):
        raise ValueError("empty or duplicate corpus")
    for entry in entries:
        if sha(args.root / entry["pdf"]) != entry["pdf_sha256"]:
            raise ValueError("source bytes changed")
    scripts = Path(__file__).parent
    repository = scripts.parents[2]
    sources = [
        Path(__file__),
        *[
            scripts / (name + ".py")
            for name in [
                "compare_opendataloader",
                "experiment_odl_font_recovery",
                "experiment_odl_native_tables",
                "experiment_odl_reading_order",
                "experiment_odl_source_styles",
                "structured_recovery",
            ]
        ],
        *[
            repository / "pipeline/pipeline" / name
            for name in ["config.py", "retrieval/chunking.py", "retrieval/lang.py"]
        ],
    ]
    if args.variant in {"extended", "refined"}:
        from experiment_odl_heading_context import rewrite, source_headings
        from experiment_odl_ocr_disagreement import (
            recover_hidden_ocr_order,
            source_facts,
        )

        sources.extend(
            scripts / (name + ".py")
            for name in [
                "experiment_odl_heading_context",
                "experiment_odl_ocr_disagreement",
            ]
        )
    if args.variant == "refined":
        from refine_odl_output import refine

        sources.extend(
            [scripts / "refine_odl_output.py", *scripts.glob("experiment_odl_*.py")]
        )
    snapshot = args.output / "source-snapshot"
    snapshot.mkdir()
    source_hashes = {}
    for path in dict.fromkeys(sources):
        name = str(path.relative_to(repository))
        target = snapshot / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(path.read_bytes())
        source_hashes[name] = sha(path)
    save(
        args.output / "run.json",
        {
            "variant": args.variant,
            "table_method": args.table_method,
            "include_header_footer": not args.exclude_header_footer,
            "entries": entries,
            "corpus_sha256": sha(args.root / "corpus.json"),
            "sources": source_hashes,
            "versions": {
                name: importlib.metadata.version(name)
                for name in ["opendataloader-pdf", "pypdf", "PyMuPDF"]
            },
            "python": platform.python_version(),
            "scope": "fresh sequential native parsing, optional native repairs, adaptation and one chunk pass; extended adds source-confirmed headings and hidden-text column order; refined adds reviewed source text/list/exponent/column/table repairs and orphan heading retention; no OCR/captions/indexing",
        },
    )
    sampler = Sampler(args.output / "resources.csv")
    sampler.thread.start()
    records = []
    began = time.monotonic()
    try:
        for entry in entries:
            started = time.monotonic()
            source = args.root / entry["pdf"]
            target = args.output / entry["id"]
            target.mkdir()
            parse_source = source
            phases, changes = {}, {}
            if args.variant != "baseline":
                phase = time.monotonic()
                font_audit = audit(source, target)
                save(target / "font-audit.json", font_audit)
                selected = [font for font in font_audit["fonts"] if font["eligible"]]
                if selected:
                    with pymupdf.open(source) as document:
                        for font in selected:
                            xref = document.get_new_xref()
                            document.update_object(xref, "<<>>")
                            document.update_stream(xref, unicode_cmap(font["encoding"]))
                            document.xref_set_key(
                                font["xref"], "ToUnicode", f"{xref} 0 R"
                            )
                        parse_source = target / "repaired.pdf"
                        document.save(parse_source)
                changes["repaired_fonts"] = len(selected)
                phases["font_audit_and_repair"] = time.monotonic() - phase
            native_folder = target / "native"
            phase = time.monotonic()
            conversion = convert(
                parse_source,
                native_folder,
                table_method=args.table_method,
                include_header_footer=not args.exclude_header_footer,
            )
            phases["convert_and_adapt"] = time.monotonic() - phase
            phases["java_process"] = conversion["seconds"]
            native = json.loads(
                (native_folder / f"{parse_source.stem}.json").read_text(
                    encoding="utf-8"
                )
            )
            phase = time.monotonic()
            with pymupdf.open(parse_source) as document:
                if args.variant != "baseline":
                    native, colors = annotate(document, native)
                    save(target / "colors.json", colors)
                    changes["colored_cells"] = len(colors)
                blocks = odl_content_list(
                    native,
                    [
                        {"width": page.rect.width, "height": page.rect.height}
                        for page in document
                    ],
                )
            for block in blocks:
                if block.get("img_path"):
                    block["img_path"] = "native/" + block["img_path"]
                    if not (target / block["img_path"]).is_file():
                        raise ValueError("missing native image")
            phases["source_styles_and_adaptation"] = time.monotonic() - phase
            phase = time.monotonic()
            if args.variant != "baseline":
                blocks, ordering = repair(blocks)
                pages = {
                    row["page"] for row in ordering if row["reason"] == "reordered"
                }
                blocks, rotated = demote_rotated(
                    blocks, pages, parse_source, demote=False
                )
                blocks, continuations = split_continuations(blocks, pages, parse_source)
                save(
                    target / "order.json",
                    {
                        "ordering": ordering,
                        "rotated": rotated,
                        "continuations": continuations,
                    },
                )
                changes["reordered_pages"] = len(pages)
                phases["reading_order"] = time.monotonic() - phase
                if args.variant in {"extended", "refined"}:
                    phase = time.monotonic()
                    with pymupdf.open(parse_source) as document:
                        facts = [source_facts(page) for page in document]
                    eligible = {i for i, fact in enumerate(facts) if fact["eligible"]}
                    blocks, hidden_order = recover_hidden_ocr_order(blocks, eligible)
                    save(
                        target / "hidden-text.json",
                        {"facts": facts, "decisions": hidden_order},
                    )
                    phases["hidden_text_order"] = time.monotonic() - phase
                    changes["hidden_text_reordered_pages"] = sum(
                        d["reordered"] for d in hidden_order
                    )
                    phase = time.monotonic()
                    headings = source_headings(blocks, parse_source)
                    blocks, heading_changes = rewrite(blocks, headings, "structure")
                    save(
                        target / "headings.json",
                        {"evidence": headings, "changes": heading_changes},
                    )
                    phases["heading_context"] = time.monotonic() - phase
                    changes["heading_changes"] = len(heading_changes)
                phase = time.monotonic()
                if args.variant == "refined":
                    blocks, chunks, evidence, refinement_phases = refine(
                        blocks, parse_source, native, table_recovery=True
                    )
                    save(target / "refinement.json", evidence)
                    phases.update(
                        {
                            "refine_" + key: value
                            for key, value in refinement_phases.items()
                        }
                    )
                    changes["source_tables"] = sum(
                        d["accepted"] for d in evidence["replacement"]
                    )
                else:
                    blocks, chunks, table_context = chunk_native_bounded(blocks)
                    save(target / "tables.json", table_context)
            else:
                chunks = chunk_content_list(blocks)
            phases["refinement" if args.variant == "refined" else "chunking"] = (
                time.monotonic() - phase
            )
            save(target / "content_list.json", blocks)
            save(
                target / "chunks.json",
                [
                    {**asdict(chunk), "indexed_text": chunk.indexed_text()}
                    for chunk in chunks
                ],
            )
            record = {
                "id": entry["id"],
                "pages": entry["pages"],
                "source_sha256": entry["pdf_sha256"],
                "parsed_pdf_sha256": sha(parse_source),
                "seconds": time.monotonic() - started,
                "phases": phases,
                "changes": changes,
                "chunks": len(chunks),
                "content_sha256": sha(target / "content_list.json"),
                "chunks_sha256": sha(target / "chunks.json"),
            }
            save(target / "result.json", record)
            records.append(record)
            print(json.dumps(record), flush=True)
    finally:
        sampler.stop.set()
        sampler.thread.join()
    save(
        args.output / "complete.json",
        {
            "seconds": time.monotonic() - began,
            "variant": args.variant,
            "records": records,
            "peak_memory_bytes": sampler.peak_memory,
            "peak_swap_bytes": sampler.peak_swap,
        },
    )


if __name__ == "__main__":
    main()
