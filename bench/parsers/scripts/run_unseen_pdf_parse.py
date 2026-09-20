"""Fresh, paired PDF parsing in the isolated parser dependency image.

Run with /repo mounted read-only, /output writable, and Docker --network none:
python /repo/bench/parsers/scripts/run_unseen_pdf_parse.py \
  --manifest /repo/bench/parsers/fixtures/unseen-pdf-sources-2026-09-20.json \
  --output /output

The current /repo/parser code supplies both arms. The frozen heading candidate
is applied only in a document subprocess, at the existing correct_roles stage.
No production files are patched. Completed attempts resume; failed attempts
require explicit --retry-failed. Each document has a 600-second paired deadline.
"""

from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.util
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[3]
PROTOTYPE = Path("bench/parsers/scripts/experiment_prince_headings.py")


def read(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for data in iter(lambda: stream.read(1 << 20), b""):
            digest.update(data)
    return digest.hexdigest()


def write(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    temporary.write_text(
        json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    temporary.replace(path)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sources_from(manifest: dict) -> list[dict]:
    sources = manifest["sources"]
    if not isinstance(sources, list) or not sources:
        raise ValueError("Manifest must contain a nonempty sources array")
    seen = set()
    for source in sources:
        name = source["id"]
        if not isinstance(name, str) or not re.fullmatch(
            r"[A-Za-z0-9][A-Za-z0-9_.-]{0,95}", name
        ):
            raise ValueError(f"Unsafe source id: {name!r}")
        if name in seen:
            raise ValueError(f"Duplicate source id: {name}")
        seen.add(name)
        if not isinstance(source["path"], str) or not source["path"]:
            raise ValueError(f"Missing local PDF path for {name}")
        if not re.fullmatch(r"[0-9a-f]{64}", source["sha256"]):
            raise ValueError(f"Missing lowercase SHA-256 for {name}")
    return sources


def source_path(source: dict) -> Path:
    return (ROOT / source["path"]).resolve()


def freeze(args, sources: list[dict]) -> dict:
    prototype = args.candidate_root / PROTOTYPE
    code = [
        Path(__file__),
        prototype,
        ROOT / "parser/app.py",
        *sorted((ROOT / "parser/odl").glob("*.py")),
    ]
    frozen = {
        "manifest_sha256": sha256(args.manifest),
        "candidate_sha256": sha256(prototype),
        "code_sha256": {str(path): sha256(path) for path in code},
        "sources": sources,
        "python": sys.version,
        "release_sha_environment": os.environ.get("RELEASE_SHA"),
    }
    path = args.output / "frozen-inputs.json"
    if path.exists():
        if read(path) != frozen:
            raise ValueError("Frozen inputs changed; use a new output directory")
    else:
        write(path, frozen)
        write(args.output / "frozen-manifest.json", read(args.manifest))
    # Validate every selected input before the first worker starts.
    for source in sources:
        if args.only and source["id"] not in args.only:
            continue
        if sha256(source_path(source)) != source["sha256"]:
            raise ValueError(f"PDF hash mismatch for {source['id']}")
    return frozen


def load_candidate(path: Path):
    spec = importlib.util.spec_from_file_location("frozen_heading_candidate", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Cannot load heading candidate {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def save_parse(directory: Path, parsed, elapsed: float, source: dict, arm: str) -> dict:
    write(directory / "content_list.json", parsed.content_list)
    write(
        directory / "refinement.json",
        {"furniture": parsed.furniture, "page_evidence": None},
    )
    (directory / "document.md").write_text(parsed.markdown, encoding="utf-8")
    images = directory / "images"
    images.mkdir()
    for name, content in parsed.images.items():
        if Path(name).name != name:
            raise ValueError(f"Unsafe exported image name: {name}")
        (images / name).write_bytes(content)
    if parsed.parsed_pdf is not None:
        (directory / "parsed.pdf").write_bytes(parsed.parsed_pdf)
    receipt = {
        "schema": "capy-local-paired-parser-arm-v1",
        "arm": arm,
        "source_sha256": source["sha256"],
        "content_list_sha256": sha256(directory / "content_list.json"),
        "refinement_sha256": sha256(directory / "refinement.json"),
        "measured_pdf_sha256": sha256(directory / "work/document.pdf"),
        "native_json_sha256": sha256(directory / "work/native/document.json"),
        "page_count": parsed.page_count,
        "ocr_pages": parsed.ocr_pages,
        "repaired_fonts": parsed.repaired_fonts,
        "image_count": len(parsed.images),
        "phases_seconds": parsed.phases,
        "wall_seconds": round(elapsed, 3),
    }
    write(directory / "parse.json", receipt)
    return receipt


def worker(args) -> None:
    # Import the complete current parser before the prototype adjusts sys.path.
    sys.path[:0] = [str(ROOT / "parser"), str(ROOT / "pipeline")]
    from odl import headings, java, refine

    frozen = read(args.output / "frozen-inputs.json")
    for name, expected in frozen["code_sha256"].items():
        if sha256(Path(name)) != expected:
            raise ValueError(f"Frozen code changed: {name}")
    source = next(s for s in frozen["sources"] if s["id"] == args.worker)
    pdf = source_path(source)
    if sha256(pdf) != source["sha256"]:
        raise ValueError("Source PDF changed after freeze")
    prototype = load_candidate(args.candidate_root / PROTOTYPE)
    directory = args.attempt
    baseline = directory / "baseline"
    candidate = directory / "candidate"
    receipts = {}
    data = pdf.read_bytes()
    for arm in [baseline, candidate]:
        (arm / "work").mkdir(parents=True)
    started = time.perf_counter()
    parsed = refine.parse_pdf(data, baseline / "work", java_timeout_s=args.timeout)
    receipts["baseline"] = save_parse(
        baseline, parsed, time.perf_counter() - started, source, "baseline"
    )
    del parsed
    gc.collect()
    print(f"{source['id']} baseline complete", flush=True)

    original_roles = headings.correct_roles
    native_hashes = {
        str(p.relative_to(baseline / "work/native")): sha256(p)
        for p in sorted((baseline / "work/native").rglob("*"))
        if p.is_file()
    }
    write(directory / "native-cache-hashes.json", native_hashes)

    def reuse_java(repaired_pdf: Path, native_dir: Path, *, timeout_s: float) -> dict:
        if sha256(repaired_pdf) != receipts["baseline"]["measured_pdf_sha256"]:
            raise ValueError(
                "Candidate repaired PDF differs; refusing native cache reuse"
            )
        shutil.copytree(baseline / "work/native", native_dir, dirs_exist_ok=True)
        copied = {
            str(p.relative_to(native_dir)): sha256(p)
            for p in sorted(native_dir.rglob("*"))
            if p.is_file()
        }
        if copied != native_hashes:
            raise ValueError("Copied Java output differs from the baseline")
        # Freshly decode the untouched disk JSON. The baseline's in-memory tree
        # has already been changed by styles/adaptation and must never be reused.
        return read(native_dir / "document.json")

    def candidate_roles(blocks: list[dict], document) -> list[dict]:
        blocks = original_roles(blocks, document)
        toc = [
            row[:3]
            + [
                {
                    "y": row[3]["to"].y / document[row[2] - 1].rect.height * 1000
                    if row[2] > 0 and row[3].get("kind") == 1 and "to" in row[3]
                    else None
                }
            ]
            for row in document.get_toc(simple=False)
        ]
        evidence = prototype.source_evidence(blocks, document)
        discarded, anchors, complete = prototype.changes(blocks, toc, evidence)
        result = prototype.candidate(blocks, discarded, anchors, "combined", complete)
        write(
            candidate / "heading-stage.json",
            {
                "stage": "after production correct_roles; before context/furniture/table recovery",
                "candidate_sha256": frozen["candidate_sha256"],
                "toc": toc,
                "source_matched_headings": len(evidence),
                "roots_complete": complete,
                "outline_roots": sum(row[0] == 1 for row in toc),
                "matched_roots": sum(level == 1 for level in anchors.values()),
                "anchors": [
                    {"index": i, "outline_level": level, **blocks[i]}
                    for i, level in anchors.items()
                ],
                "changes": [
                    {"index": i, "before": before, "after": after}
                    for i, (before, after) in enumerate(zip(blocks, result))
                    if before != after
                ],
            },
        )
        return result

    started = time.perf_counter()
    with (
        patch.object(java, "run", reuse_java),
        patch.object(headings, "correct_roles", candidate_roles),
    ):
        parsed = refine.parse_pdf(data, candidate / "work", java_timeout_s=args.timeout)
    receipts["candidate"] = save_parse(
        candidate, parsed, time.perf_counter() - started, source, "candidate"
    )
    if (
        receipts["baseline"]["native_json_sha256"]
        != receipts["candidate"]["native_json_sha256"]
    ):
        raise AssertionError("Paired native JSON hashes differ")
    dependencies = {}
    for package in [
        "opendataloader-pdf",
        "pymupdf",
        "pypdf",
        "rapidocr",
        "rapid-layout",
        "onnxruntime",
    ]:
        try:
            dependencies[package] = version(package)
        except PackageNotFoundError:
            dependencies[package] = "not installed"
    write(
        directory / "completed.json",
        {
            "source": source,
            "finished_at": now(),
            "arms": receipts,
            "native_cache_reused": True,
            "dependencies": dependencies,
            "jvm_max_heap": java.JVM_MAX_HEAP,
            "java_flags": java.ODL_FLAGS,
            "production_parser_directory": str(Path(refine.__file__).parent),
        },
    )
    print(f"{source['id']} candidate complete", flush=True)


def run(args) -> int:
    if os.name != "posix":
        raise RuntimeError(
            "Run paired parsing inside the isolated Linux parser container"
        )
    sources = sources_from(read(args.manifest))
    known = {s["id"] for s in sources}
    if args.only and not set(args.only) <= known:
        raise ValueError(f"Unknown --only ids: {set(args.only) - known}")
    freeze(args, sources)
    failures = 0
    for source in sources:
        name = source["id"]
        if args.only and name not in args.only:
            continue
        folder = args.output / name
        status_path = folder / "status.json"
        previous = read(status_path) if status_path.exists() else None
        if previous and (previous["status"] == "complete" or not args.retry_failed):
            print(f"{name}: retained {previous['status']} attempt", flush=True)
            failures += previous["status"] != "complete"
            continue
        attempt = folder / f"attempt-{len(list(folder.glob('attempt-*'))) + 1:04d}"
        attempt.mkdir(parents=True)
        status = {
            "id": name,
            "status": "running",
            "started_at": now(),
            "source_sha256": source["sha256"],
            "attempt_directory": str(attempt.relative_to(args.output)),
            "timeout_seconds": args.timeout,
        }
        write(status_path, status)
        command = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--manifest",
            str(args.manifest),
            "--output",
            str(args.output),
            "--candidate-root",
            str(args.candidate_root),
            "--timeout",
            str(args.timeout),
            "--worker",
            name,
            "--attempt",
            str(attempt),
        ]
        started = time.perf_counter()
        with (attempt / "worker.log").open("w", encoding="utf-8") as log:
            process = subprocess.Popen(
                command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
            )
            try:
                returncode = process.wait(timeout=args.timeout)
                status["status"] = (
                    "complete"
                    if returncode == 0 and (attempt / "completed.json").is_file()
                    else "failed"
                )
                status["returncode"] = returncode
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
                status.update(status="timed_out", returncode=process.returncode)
        status.update(
            finished_at=now(), wall_seconds=round(time.perf_counter() - started, 3)
        )
        write(attempt / "status.json", status)
        write(status_path, status)
        failures += status["status"] != "complete"
        print(json.dumps(status), flush=True)
    return 1 if failures else 0


def self_check() -> None:
    valid = {"sources": [{"id": "source-1", "path": "a.pdf", "sha256": "a" * 64}]}
    assert sources_from(valid)[0]["id"] == "source-1"
    for changed in [{"id": "../escape"}, {"sha256": "bad"}]:
        try:
            sources_from({"sources": [{**valid["sources"][0], **changed}]})
        except ValueError:
            pass
        else:
            raise AssertionError("Invalid manifest accepted")
    print("Manifest self-check passed; no parsing or subprocess jobs ran.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--candidate-root", type=Path, default=ROOT)
    parser.add_argument("--only", nargs="+")
    parser.add_argument("--timeout", type=float, default=600)
    parser.add_argument("--retry-failed", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    parser.add_argument("--worker", help=argparse.SUPPRESS)
    parser.add_argument("--attempt", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.self_check:
        self_check()
        return 0
    if args.manifest is None or args.output is None or args.timeout <= 0:
        parser.error("--manifest, --output and a positive --timeout are required")
    args.manifest, args.output, args.candidate_root = (
        args.manifest.resolve(),
        args.output.resolve(),
        args.candidate_root.resolve(),
    )
    if args.worker:
        try:
            worker(args)
        except Exception as exc:
            write(
                args.attempt / "failure.json",
                {
                    "failed_at": now(),
                    "type": type(exc).__name__,
                    "message": str(exc),
                    "traceback": traceback.format_exc(),
                },
            )
            raise
        return 0
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
