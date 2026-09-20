"""Fresh production parser runs with frozen code/source identities and bounded workers.

Run in an isolated Linux parser dependency image with /repo read-only and local
output storage. No ingestion, embedding, library or application state is used.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import signal
import subprocess
import sys
import time
from dataclasses import asdict
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
sys.path[:0] = [str(ROOT / "parser"), str(ROOT / "pipeline")]


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def identities(manifest):
    paths = [
        Path(__file__),
        manifest,
        ROOT / "parser/app.py",
        *sorted((ROOT / "parser/odl").glob("*.py")),
        *(
            ROOT / "pipeline/pipeline/retrieval" / f"{name}.py"
            for name in ["chunking", "packing", "headings", "confidence"]
        ),
    ]
    return {str(path): digest(path) for path in paths}


def worker(args, source):
    import pymupdf
    from odl import headings, refine

    from pipeline.retrieval.confidence import score_chunks
    from pipeline.retrieval.headings import retain_headings
    from pipeline.retrieval.packing import pack_blocks

    folder = args.output / source["id"]
    pdf = ROOT / source["path"]
    assert digest(pdf) == source["sha256"], "Source identity changed"
    assert identities(args.manifest) == read(args.output / "inputs.json"), (
        "Code identity changed"
    )
    data = pdf.read_bytes()
    original_roles = headings.correct_roles

    def record_roles(blocks, document):
        revised = original_roles(blocks, document)
        write(
            folder / "heading-stage.json",
            {
                "changes": [
                    {"index": i, "before": a, "after": b}
                    for i, (a, b) in enumerate(zip(blocks, revised))
                    if a != b
                ],
                "block_count_before": len(blocks),
                "block_count_after": len(revised),
            },
        )
        return revised

    work = folder / "work"
    work.mkdir()
    started = time.perf_counter()
    with patch.object(headings, "correct_roles", record_roles):
        result = refine.parse_pdf(data, work, java_timeout_s=args.timeout)
    parse_seconds = time.perf_counter() - started
    measured = work / "document.pdf"
    chunks = retain_headings(
        result.content_list,
        measured,
        pack_blocks(result.content_list, frozenset(result.furniture)),
    )
    score_chunks(chunks, measured, ocr=set(result.ocr_pages))
    write(folder / "content_list.json", result.content_list)
    write(folder / "chunks.json", [asdict(chunk) for chunk in chunks])
    write(folder / "refinement.json", {"furniture": result.furniture})
    if result.parsed_pdf is not None:
        (folder / "parsed.pdf").write_bytes(result.parsed_pdf)
    with (
        pymupdf.open(stream=data, filetype="pdf") as original,
        pymupdf.open(measured) as parsed,
    ):
        fidelity = {
            "pages_equal": len(original) == len(parsed),
            "geometry_equal": [tuple(p.rect) for p in original]
            == [tuple(p.rect) for p in parsed],
            "outline_equal": original.get_toc() == parsed.get_toc(),
        }
        if "java_structure_retry" in result.phases:
            fidelity.update(
                text_equal=all(
                    a.get_text() == b.get_text() for a, b in zip(original, parsed)
                ),
                pixels_equal=all(
                    a.get_pixmap().samples == b.get_pixmap().samples
                    for a, b in zip(original, parsed)
                ),
                permissions_equal=original.permissions == parsed.permissions,
                encryption_equal=original.metadata["encryption"]
                == parsed.metadata["encryption"],
            )
    assert digest(pdf) == source["sha256"], "Original source changed"
    assert identities(args.manifest) == read(args.output / "inputs.json"), (
        "Code changed during run"
    )
    write(
        folder / "result.json",
        {
            "id": source["id"],
            "source_sha256": source["sha256"],
            "measured_sha256": digest(measured),
            "pages": result.page_count,
            "blocks": len(result.content_list),
            "chunks": len(chunks),
            "parse_seconds": parse_seconds,
            "phases": result.phases,
            "ocr_pages": result.ocr_pages,
            "repaired_fonts": result.repaired_fonts,
            "fidelity": fidelity,
        },
    )


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--manifest", type=Path, required=True)
    cli.add_argument("--output", type=Path, required=True)
    cli.add_argument("--only", nargs="+")
    cli.add_argument("--timeout", type=int, default=600)
    cli.add_argument("--worker")
    args = cli.parse_args()
    sources = read(args.manifest)["sources"]
    by_id = {source["id"]: source for source in sources}
    if args.worker:
        worker(args, by_id[args.worker])
        return
    if os.name != "posix":
        cli.error("Use an isolated Linux parser container")
    if args.only and not set(args.only) <= by_id.keys():
        cli.error("Unknown source id")
    args.output.mkdir(parents=True, exist_ok=False)
    write(args.output / "inputs.json", identities(args.manifest))
    selected = [by_id[name] for name in args.only] if args.only else sources
    summary = []
    for source in selected:
        folder = args.output / source["id"]
        folder.mkdir()
        started = time.perf_counter()
        status = {"id": source["id"], "status": "running"}
        write(folder / "status.json", status)
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--manifest",
            str(args.manifest),
            "--output",
            str(args.output),
            "--timeout",
            str(args.timeout),
            "--worker",
            source["id"],
        ]
        with (folder / "worker.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
            try:
                code = process.wait(timeout=args.timeout)
                status.update(
                    status="complete" if code == 0 else "failed", returncode=code
                )
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                status.update(status="timed_out", returncode=process.returncode)
        status["wall_seconds"] = round(time.perf_counter() - started, 3)
        write(folder / "status.json", status)
        summary.append(status)
        write(args.output / "summary.json", summary)
        print(json.dumps(status), flush=True)
    if any(item["status"] != "complete" for item in summary):
        raise SystemExit(1)


if __name__ == "__main__":
    main()
