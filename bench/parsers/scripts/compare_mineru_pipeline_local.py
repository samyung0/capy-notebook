"""Fresh ODL/MinerU pipeline comparison on frozen matched PDF slices.

prepare runs on the host. run executes in the isolated benchmark image: use
the image's default Python for ODL and /opt/mineru/bin/python for MinerU.
Each run preserves raw outputs and stage timings; it never indexes data.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/parsers/fixtures/mineru-pipeline-textbook-comparison.json"


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def sha(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def prepare(output: Path) -> None:
    import pymupdf

    if (output / "manifest.json").exists():
        raise FileExistsError("Use a new output directory for a new source freeze")
    fixture = read(FIXTURE)
    books = read(ROOT / fixture["book_manifest"])["books"]
    legacy_path = ROOT / fixture["legacy_manifest"]
    sources = {b["id"]: (ROOT / b["pdf_path"], b["sha256"]) for b in books}
    sources.update(
        {
            b["source_id"]: (legacy_path.parent / b["pdf"], b["pdf_sha256"])
            for b in read(legacy_path)["sources"]
        }
    )
    cases = []
    (output / "inputs").mkdir(parents=True, exist_ok=True)
    for case in fixture["cases"]:
        source, expected = sources[case["source"]]
        if sha(source) != expected:
            raise ValueError(f"Source mismatch: {case['source']}")
        target = output / "inputs" / f"{case['id']}.pdf"
        with pymupdf.open(source) as original, pymupdf.open() as sliced:
            for page in case["pages"]:
                sliced.insert_pdf(original, from_page=page - 1, to_page=page - 1)
            sliced.save(target, garbage=4, deflate=True)
        cases.append(
            {
                **case,
                "source_sha256": expected,
                "source_path": source.relative_to(ROOT).as_posix(),
                "pdf": target.relative_to(output).as_posix(),
                "pdf_sha256": sha(target),
            }
        )
    save(
        output / "manifest.json",
        {
            "frozen_at": datetime.now(timezone.utc).isoformat(),
            "fixture_sha256": sha(FIXTURE),
            "cases": cases,
            "checks": fixture["source_checks"],
            "slice_caveat": fixture["description"],
        },
    )
    print(
        json.dumps({"cases": len(cases), "pages": sum(len(c["pages"]) for c in cases)})
    )


def run(
    output: Path, engine: str, name: str, repeats: int, selected: str | None
) -> None:
    manifest = read(output / "manifest.json")
    destination = output / "runs" / name
    destination.mkdir(parents=True, exist_ok=False)
    cases = [c for c in manifest["cases"] if selected is None or c["id"] == selected]
    if not cases:
        raise ValueError("No selected cases")
    for case in cases:
        if sha(output / case["pdf"]) != case["pdf_sha256"]:
            raise ValueError("Frozen input changed")
    import_start = time.perf_counter()
    if engine == "odl":
        sys.path.insert(0, str(ROOT / "parser"))
        from odl.refine import parse_pdf

        package = "opendataloader-pdf"
    else:
        import torch

        torch.set_num_threads(4)
        from mineru.cli.common import do_parse

        package = "mineru"
    import_seconds = time.perf_counter() - import_start
    environment = {
        "engine": engine,
        "package_version": importlib.metadata.version(package),
        "python": sys.version,
        "platform": platform.platform(),
        "import_seconds": import_seconds,
        "script_sha256": sha(Path(__file__)),
        "manifest_sha256": sha(output / "manifest.json"),
        "environment": {
            k: os.getenv(k)
            for k in (
                "OMP_NUM_THREADS",
                "MKL_NUM_THREADS",
                "OPENBLAS_NUM_THREADS",
                "MINERU_DEVICE_MODE",
                "MINERU_MODEL_SOURCE",
            )
        },
    }
    save(destination / "environment.json", environment)
    records = []
    for repeat in range(repeats):
        for case in cases:
            case_dir = destination / f"r{repeat + 1}" / case["id"]
            case_dir.mkdir(parents=True)
            data = (output / case["pdf"]).read_bytes()
            started = time.perf_counter()
            if engine == "odl":
                parsed = parse_pdf(data, case_dir, java_timeout_s=600)
                parse_seconds = time.perf_counter() - started
                blocks = parsed.content_list
                save(case_dir / "content_list.json", blocks)
                save(case_dir / "refinement.json", {"furniture": parsed.furniture})
                (case_dir / "document.md").write_text(parsed.markdown, encoding="utf-8")
                if parsed.parsed_pdf is not None:
                    (case_dir / "parsed.pdf").write_bytes(parsed.parsed_pdf)
                details = {
                    "phases": parsed.phases,
                    "ocr_pages": parsed.ocr_pages,
                    "repaired_fonts": parsed.repaired_fonts,
                }
            else:
                do_parse(
                    str(case_dir),
                    [case["id"]],
                    [data],
                    [case["language"]],
                    backend="pipeline",
                    parse_method="auto",
                    formula_enable=True,
                    table_enable=True,
                    f_draw_layout_bbox=False,
                    f_draw_span_bbox=False,
                    f_dump_orig_pdf=False,
                    f_dump_model_output=True,
                    f_dump_md=True,
                    f_dump_middle_json=True,
                    f_dump_content_list=True,
                )
                parse_seconds = time.perf_counter() - started
                candidates = list(case_dir.rglob("*_content_list.json"))
                if len(candidates) != 1:
                    raise ValueError("MinerU did not produce one content list")
                blocks = read(candidates[0])
                save(case_dir / "content_list.json", blocks)
                details = {
                    "native_content_list": str(candidates[0].relative_to(destination)),
                    "method": "auto",
                    "formula_enable": True,
                    "table_enable": True,
                }
            record = {
                "case": case["id"],
                "repeat": repeat + 1,
                "pages": len(case["pages"]),
                "parse_seconds": parse_seconds,
                "blocks": len(blocks),
                "first_case_in_process": not records,
                **details,
            }
            records.append(record)
            save(case_dir / "result.json", record)
            save(destination / "results.json", records)
            print(json.dumps(record), flush=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("prepare", "run"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine", choices=("odl", "mineru"))
    parser.add_argument("--name")
    parser.add_argument("--repeats", type=int, default=2)
    parser.add_argument("--case")
    args = parser.parse_args()
    if args.command == "prepare":
        prepare(args.output)
    else:
        if not args.engine or not args.name or args.repeats < 1:
            parser.error("run needs --engine, --name and positive --repeats")
        run(args.output, args.engine, args.name, args.repeats, args.case)


if __name__ == "__main__":
    main()
