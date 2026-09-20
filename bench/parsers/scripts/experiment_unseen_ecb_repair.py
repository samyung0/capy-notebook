"""Post-holdout ECB repair experiment; run offline in the parser dependency image.

Use current /repo/parser and /repo/pipeline, with /repo mounted read-only. Output
must be a new container-local directory. The original holdout remains a failure.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from collections import Counter
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / "bench/parsers/fixtures/local/2026-09-20-unseen-pdfs/ecb-annual2024.pdf"
EXPECTED = "9b1fa8402e6a50c318dba51c8158a14a54319dab92b3f25e0dfbc4a0e4ab43cc"
FROZEN = (
    ROOT
    / "bench/parsers/reports/local/2026-09-20-unseen-pdf-validation/parse/frozen-inputs.json"
)


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write(path: Path, value) -> None:
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def rewrite(document: pymupdf.Document, keep_encryption: bool) -> bytes:
    return document.tobytes(
        garbage=0,
        deflate=False,
        no_new_id=True,
        encryption=pymupdf.PDF_ENCRYPT_KEEP
        if keep_encryption
        else pymupdf.PDF_ENCRYPT_NONE,
    )


def xref_evidence(data: bytes) -> dict:
    matches = list(re.finditer(rb"startxref\s+(\d+)", data))
    offset = int(matches[-1][1])
    return {
        "startxref_occurrences": len(matches),
        "last_startxref": offset,
        "last_xref_prefix": data[offset : offset + 1600].decode("latin1"),
        "last_trailer": data[-800:].decode("latin1"),
    }


def fidelity(original: bytes, rewritten: bytes, expected_pages: int) -> dict:
    pages = []
    with (
        pymupdf.open(stream=original, filetype="pdf") as left,
        pymupdf.open(stream=rewritten, filetype="pdf") as right,
    ):
        assert len(left) == len(right) == expected_pages
        for old, new in zip(left, right):
            a = old.get_pixmap(
                dpi=72, colorspace=pymupdf.csRGB, alpha=False, annots=True
            )
            b = new.get_pixmap(
                dpi=72, colorspace=pymupdf.csRGB, alpha=False, annots=True
            )
            record = {
                "page": old.number + 1,
                "original_text_sha256": digest(old.get_text().encode()),
                "derived_text_sha256": digest(new.get_text().encode()),
                "original_pixel_sha256": digest(a.samples),
                "derived_pixel_sha256": digest(b.samples),
                "geometry_equal": (
                    old.rect == new.rect
                    and old.mediabox == new.mediabox
                    and old.cropbox == new.cropbox
                    and old.rotation == new.rotation
                    and (a.width, a.height, a.stride) == (b.width, b.height, b.stride)
                ),
                "links_equal": old.get_links() == new.get_links(),
            }
            record["text_equal"] = (
                record["original_text_sha256"] == record["derived_text_sha256"]
            )
            record["pixels_equal"] = (
                record["original_pixel_sha256"] == record["derived_pixel_sha256"]
            )
            pages.append(record)
        # garbage=0 preserves xref identities, so detailed destinations compare directly.
        return {
            "page_count": len(left),
            "outline_entries": len(left.get_toc()),
            "outline_equal": left.get_toc(simple=False) == right.get_toc(simple=False),
            "metadata_equal": left.metadata == right.metadata,
            "metadata_differences": {
                key: {"original": value, "derived": right.metadata.get(key)}
                for key, value in left.metadata.items()
                if value != right.metadata.get(key)
            },
            "xml_metadata_equal": left.get_xml_metadata() == right.get_xml_metadata(),
            "page_labels_equal": left.get_page_labels() == right.get_page_labels(),
            "catalog_equal": left.xref_object(left.pdf_catalog())
            == right.xref_object(right.pdf_catalog()),
            "catalog_keys_equal": {
                key: left.xref_get_key(left.pdf_catalog(), key)
                for key in left.xref_get_keys(left.pdf_catalog())
            }
            == {
                key: right.xref_get_key(right.pdf_catalog(), key)
                for key in right.xref_get_keys(right.pdf_catalog())
            },
            "catalog_original": left.xref_object(left.pdf_catalog()),
            "catalog_derived": right.xref_object(right.pdf_catalog()),
            "all_text_equal": all(p["text_equal"] for p in pages),
            "all_pixels_equal": all(p["pixels_equal"] for p in pages),
            "all_geometry_equal": all(p["geometry_equal"] for p in pages),
            "all_links_equal": all(p["links_equal"] for p in pages),
            "pages": pages,
        }


def controls(output: Path, keep_encryption: bool) -> None:
    selected = {
        "prince-math",
        "bccampus-accessibility",
        "ctan-axessibility",
        "w3c-complex-table",
        "w3c-openoffice-columns",
        "snu-admissions",
        "mu-calculus",
        "jstage-1949-statistics",
    }
    frozen = json.loads(FROZEN.read_text())
    rows = []
    for source in frozen["sources"]:
        if source["id"] not in selected:
            continue
        path = ROOT / source["path"]
        original = path.read_bytes()
        assert digest(original) == source["sha256"]
        with pymupdf.open(stream=original, filetype="pdf") as document:
            rewritten = rewrite(document, keep_encryption)
        started = time.perf_counter()
        result = fidelity(original, rewritten, source["pages"])
        result.update(
            {
                "id": source["id"],
                "keep_encryption": keep_encryption,
                "original_sha256": digest(original),
                "derived_sha256": digest(rewritten),
                "original_unchanged": digest(path.read_bytes()) == source["sha256"],
                "wall_seconds": time.perf_counter() - started,
            }
        )
        write(output / (source["id"] + ".json"), result)
        rows.append({key: value for key, value in result.items() if key != "pages"})
        print(f"Fidelity control complete: {source['id']}", flush=True)
    assert {row["id"] for row in rows} == selected
    write(output / "controls.json", rows)


def main() -> None:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--output", type=Path, required=True)
    cli.add_argument("--timeout", type=float, required=True)
    cli.add_argument("--controls", action="store_true")
    arm = cli.add_mutually_exclusive_group(required=True)
    arm.add_argument("--keep-encryption", action="store_true")
    arm.add_argument("--initial-save", action="store_true")
    args = cli.parse_args()
    args.output.mkdir(parents=True, exist_ok=False)
    if args.controls:
        controls(args.output, args.keep_encryption)
        return
    sys.path[:0] = [str(ROOT / "parser"), str(ROOT / "pipeline")]
    from odl import java, refine

    frozen = json.loads(FROZEN.read_text())
    code = {
        name: digest(Path(name).read_bytes())
        for name in frozen["code_sha256"]
        if name.startswith("/repo/parser/")
    }
    assert all(value == frozen["code_sha256"][name] for name, value in code.items())
    original = SOURCE.read_bytes()
    assert digest(original) == EXPECTED
    started = time.perf_counter()
    with pymupdf.open(stream=original, filetype="pdf") as document:
        was_repaired = document.is_repaired
        rewritten = rewrite(document, args.keep_encryption)
    rewrite_seconds = time.perf_counter() - started
    derivative = args.output / "derived.pdf"
    derivative.write_bytes(rewritten)
    write(
        args.output / "source-structure.json",
        {"original": xref_evidence(original), "derived": xref_evidence(rewritten)},
    )
    started = time.perf_counter()
    comparisons = fidelity(original, rewritten, 200)
    comparisons["wall_seconds"] = time.perf_counter() - started
    write(args.output / "fidelity.json", comparisons)
    assert all(
        comparisons[key]
        for key in (
            "all_text_equal",
            "all_pixels_equal",
            "all_geometry_equal",
            "outline_equal",
        )
    )
    print("All 200 pages preserve text, pixels, geometry and outline", flush=True)

    original_copy = args.output / "original.pdf"
    original_copy.write_bytes(original)
    native_dir = args.output / "original-native"
    native_dir.mkdir()
    command = [
        "java",
        f"-Xmx{java.JVM_MAX_HEAP}",
        "-Djava.awt.headless=true",
        "-jar",
        str(java.jar_path()),
        str(original_copy),
        "--output-dir",
        str(native_dir),
        *java.ODL_FLAGS,
    ]
    started = time.perf_counter()
    baseline = subprocess.run(
        command,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=args.timeout,
        check=False,
    )
    write(
        args.output / "original-java.json",
        {
            "command": command,
            "returncode": baseline.returncode,
            "wall_seconds": time.perf_counter() - started,
            "stdout": baseline.stdout,
            "stderr": baseline.stderr,
        },
    )
    print(
        f"Original ODL exit={baseline.returncode}; starting derived parse", flush=True
    )
    work = args.output / "work"
    work.mkdir()
    receipt = {
        "experiment": "post-holdout development, not unseen validation",
        "started_at": datetime.now(timezone.utc).isoformat(),
        "original_sha256": EXPECTED,
        "derived_sha256": digest(rewritten),
        "original_bytes": len(original),
        "derived_bytes": len(rewritten),
        "rewrite": {
            "garbage": 0,
            "deflate": False,
            "no_new_id": True,
            "keep_encryption": args.keep_encryption,
            "seconds": rewrite_seconds,
        },
        "pymupdf_open_is_repaired": was_repaired,
        "versions": {name: version(name) for name in ("pymupdf", "opendataloader-pdf")},
        "code_sha256": code,
        "original_odl_returncode": baseline.returncode,
    }
    write(args.output / "experiment.json", receipt)
    started = time.perf_counter()
    try:
        parsed = refine.parse_pdf(rewritten, work, java_timeout_s=args.timeout)
        write(args.output / "content_list.json", parsed.content_list)
        write(
            args.output / "image-hashes.json",
            {name: digest(data) for name, data in parsed.images.items()},
        )
        receipt["parse"] = {
            "success": True,
            "page_count": parsed.page_count,
            "content_blocks": len(parsed.content_list),
            "block_types": dict(Counter(b.get("type") for b in parsed.content_list)),
            "image_count": len(parsed.images),
            "ocr_pages": parsed.ocr_pages,
            "repaired_fonts": parsed.repaired_fonts,
            "phases_seconds": parsed.phases,
            "native_json_sha256": digest((work / "native/document.json").read_bytes()),
            "measured_pdf_sha256": digest((work / "document.pdf").read_bytes()),
        }
    except Exception as error:  # noqa: BLE001 - retain a failed experiment receipt.
        receipt["parse"] = {
            "success": False,
            "type": type(error).__name__,
            "message": str(error),
        }
    receipt["parse"]["wall_seconds"] = time.perf_counter() - started
    receipt["original_unchanged"] = digest(SOURCE.read_bytes()) == EXPECTED
    receipt["parser_unchanged"] = all(
        digest(Path(name).read_bytes()) == expected for name, expected in code.items()
    )
    write(args.output / "experiment.json", receipt)
    print(json.dumps(receipt["parse"], ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
