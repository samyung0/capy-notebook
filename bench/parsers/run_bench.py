"""Benchmark CPU-only document parsers against Evo's content_list contract.

Measures the two things that decide whether the fast parse route can leave the
GPU: throughput per vCPU, and whether the output still carries the structure the
retrieval pipeline depends on (heading depth, tables, bounding boxes).

Accuracy is deliberately NOT scored here. Published olmOCR-bench numbers already
cover that, and re-scoring it properly needs ground truth we do not have. What
this measures is the part no public benchmark can tell you: how much of *your*
content_list survives, and how fast, on a box the size you would actually rent.

Run it in Docker so the core count is pinned and comparable to a VM:

    docker build -t evo-parse-bench bench/parsers
    docker run --rm --cpus=4 \
      -v "$PWD/bench/parsers/docs:/bench/docs:ro" \
      -v "$PWD/bench/parsers/out:/out" \
      -v evo-parse-models:/models \
      evo-parse-bench --threads 4

Add ``--probe`` on the first run: it prints each library's version and Marker's
real CLI flags instead of parsing anything, which is the fastest way to find out
whether an upstream rename has broken the invocations below.
"""

from __future__ import annotations

import argparse
import json
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import normalize

SUPPORTED_SUFFIXES = {".pdf", ".png", ".jpg", ".jpeg", ".pptx", ".docx", ".xlsx"}

# Matches modal/parse_common.py. "ch" covers Chinese, Japanese and Latin scripts
# but not Korean, so keep it identical to production rather than tuning it here.
MINERU_LANG = "ch"


@dataclass
class DocResult:
    name: str
    pages: int
    seconds: float
    items: list[dict[str, Any]] = field(default_factory=list)
    error: str = ""


@dataclass
class BackendResult:
    backend: str
    version: str
    docs: list[DocResult] = field(default_factory=list)
    error: str = ""
    load_seconds: float = 0.0


# ------------------------------------------------------------------- helpers


def page_count(path: Path, fallback_items: list[dict[str, Any]] | None = None) -> int:
    if path.suffix.lower() == ".pdf":
        try:
            import pypdfium2

            pdf = pypdfium2.PdfDocument(str(path))
            try:
                return len(pdf)
            finally:
                pdf.close()
        except Exception:  # noqa: BLE001, S110 — fall through to the block-derived count
            pass
    # Office formats and images have no page count until something parses them,
    # so infer it from whatever the parser reported.
    pages = [
        int(item["page_idx"])
        for item in (fallback_items or [])
        if isinstance(item.get("page_idx"), int)
    ]
    return (max(pages) + 1) if pages else 1


def truncate_docs(docs: list[Path], max_pages: int, work: Path) -> list[Path]:
    """Copy each PDF down to its first ``max_pages`` pages.

    Truncating up front rather than passing each library its own page-range flag
    means every backend provably sees byte-identical input. A 125-page textbook
    across six backends at ~0.1 pg/s is hours; capped, the comparison is minutes
    and the per-page rates are unchanged.
    """
    work.mkdir(parents=True, exist_ok=True)
    prepared: list[Path] = []
    try:
        import pypdfium2
    except Exception:  # noqa: BLE001 — without pypdfium2 just use the originals
        return docs

    for doc in docs:
        if doc.suffix.lower() != ".pdf":
            prepared.append(doc)
            continue
        target = work / doc.name
        try:
            source = pypdfium2.PdfDocument(str(doc))
            try:
                total = len(source)
                if total <= max_pages:
                    # Copy anyway, so the capped directory is a complete input
                    # set that a second image (e.g. Dockerfile.mineru) can be
                    # pointed at directly and provably see the same bytes.
                    shutil.copy2(doc, target)
                    prepared.append(target)
                    continue
                clipped = pypdfium2.PdfDocument.new()
                clipped.import_pages(source, list(range(max_pages)))
                clipped.save(str(target))
            finally:
                source.close()
        except Exception as exc:  # noqa: BLE001 — a failed clip must not hide the doc
            print(f"    could not truncate {doc.name} ({exc}); using full file")
            prepared.append(doc)
            continue
        print(f"    {doc.name}: capped {total} -> {max_pages} pages")
        prepared.append(target)
    return prepared


def version_of(package: str) -> str:
    try:
        from importlib.metadata import version

        return version(package)
    except Exception:  # noqa: BLE001 — a missing version must not stop a run
        return "unknown"


def blank_pdf(directory: Path) -> Path | None:
    """A one-page empty PDF, for separating model load from parse work.

    Every backend here loads several GB of weights lazily, which otherwise
    lands entirely on whichever document happens to sort first and makes it
    look 40% slower than an identical document later in the run.
    """
    try:
        import pypdfium2

        directory.mkdir(parents=True, exist_ok=True)
        path = directory / "blank.pdf"
        pdf = pypdfium2.PdfDocument.new()
        pdf.new_page(612, 792)
        pdf.save(str(path))
        pdf.close()
        return path
    except Exception:  # noqa: BLE001 — a missing constant beats a dead benchmark
        return None


def _skipped(docs: list[Path]) -> list[DocResult]:
    """Record documents a backend never got to, so the row stays honest.

    A backend that gave up after one document must not look like it only ever
    had one document to parse.
    """
    return [
        DocResult(
            name=doc.name, pages=0, seconds=0.0, error="skipped after doc timeout"
        )
        for doc in docs
    ]


def metrics(items: list[dict[str, Any]]) -> dict[str, Any]:
    kinds = Counter(str(item.get("type") or "?") for item in items)
    headings = [i for i in items if isinstance(i.get("text_level"), int)]
    inferred = [i for i in headings if i.get("_level_inferred")]
    distinct_levels = {int(i["text_level"]) for i in headings}
    with_bbox = [
        i for i in items if isinstance(i.get("bbox"), list) and len(i["bbox"]) == 4
    ]
    with_page = [i for i in items if isinstance(i.get("page_idx"), int)]
    chars = sum(
        len(str(item.get("text") or "") + str(item.get("table_body") or ""))
        for item in items
    )
    return {
        "blocks": len(items),
        "text": kinds.get("text", 0),
        "tables": kinds.get("table", 0),
        "equations": kinds.get("equation", 0),
        "images": kinds.get("image", 0),
        "headings": len(headings),
        "headings_inferred_level": len(inferred),
        "heading_depth": len(distinct_levels),
        "bbox_coverage": (len(with_bbox) / len(items)) if items else 0.0,
        "page_coverage": (len(with_page) / len(items)) if items else 0.0,
        "chars": chars,
    }


# -------------------------------------------------------------------- marker


def _marker_cmd(
    docs_dir: Path, out_dir: Path, threads: int, disable_ocr: bool
) -> list[str]:
    cmd = [
        "marker",
        str(docs_dir),
        "--output_dir",
        str(out_dir),
        "--output_format",
        "json",
        "--mode",
        "fast",
        "--workers",
        str(max(1, threads)),
    ]
    if disable_ocr:
        cmd.append("--disable_ocr")
    return cmd


def _marker_invoke(
    docs_dir: Path,
    work: Path,
    threads: int,
    disable_ocr: bool,
    timeout_s: float,
    log_path: Path | None,
) -> tuple[float, str, bool]:
    """Run the Marker CLI over ``docs_dir``. Returns (seconds, error, timed_out)."""
    cmd = _marker_cmd(docs_dir, work, threads, disable_ocr)
    started = time.perf_counter()
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True, check=False, timeout=timeout_s
        )
    except subprocess.TimeoutExpired:
        return time.perf_counter() - started, f"timed out after {timeout_s:.0f}s", True
    seconds = time.perf_counter() - started
    if proc.returncode != 0:
        # Keep the whole log: the useful line in a Marker failure is usually the
        # final exception, but the cause (a missing inference server, a device
        # assertion) is often hundreds of lines earlier in a click traceback.
        if log_path is not None:
            log_path.write_text(
                f"$ {' '.join(cmd)}\n\n--- stdout ---\n{proc.stdout}"
                f"\n--- stderr ---\n{proc.stderr}",
                encoding="utf-8",
            )
        tail = (proc.stderr or proc.stdout).strip().splitlines()
        error = " | ".join(tail[-4:])[:600] if tail else f"exit {proc.returncode}"
        if log_path is not None:
            error += f" (full log: {log_path.name})"
        return seconds, error, False
    return seconds, "", False


def _marker_startup_s(threads: int, disable_ocr: bool) -> float:
    """Time Marker on a blank one-page PDF.

    Marker is invoked once per document below, so every per-document number
    re-pays model load. Measuring that constant separately makes the rest
    subtractable instead of silently inflated.

    Run twice and keep the second: the first invocation also pays first-touch
    reads of a few GB of weights, which the OS page cache then serves to every
    later invocation. Reporting the cold number would overstate the constant
    and make real documents look faster than the blank page.
    """
    with tempfile.TemporaryDirectory() as tmp:
        blank_dir = Path(tmp) / "in"
        if blank_pdf(blank_dir) is None:
            return 0.0
        seconds = 0.0
        for attempt in range(2):
            seconds, _, _ = _marker_invoke(
                blank_dir, Path(tmp) / f"out{attempt}", threads, disable_ocr, 900, None
            )
        return seconds


def _marker_items(work: Path, doc: Path) -> list[dict[str, Any]]:
    for candidate in work.rglob(f"{doc.stem}*.json"):
        try:
            payload = json.loads(candidate.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001, S112 — try the next candidate file
            continue
        return normalize.from_marker(payload)
    return []


def run_marker(
    docs: list[Path],
    out_dir: Path,
    threads: int,
    *,
    disable_ocr: bool,
    doc_timeout_s: float,
) -> BackendResult:
    """Marker v2's `fast` mode, one document per CLI invocation.

    Batching the whole directory into a single call is faster (model load is
    paid once) but the per-document seconds it yields are fiction: the only
    observable number is batch wall time, split by page share. On a mixed set
    that hides exactly what we are trying to price, because one scanned page
    can cost more than a whole born-digital chapter. One call per document
    costs a model load each time — measured separately as ``load_seconds`` —
    and buys real per-document latency plus a timeout that contains a single
    pathological file instead of stalling the run.
    """
    label = "marker-fast-noocr" if disable_ocr else "marker-fast"
    result = BackendResult(backend=label, version=version_of("marker-pdf"))
    if shutil.which("marker") is None:
        result.error = "marker CLI not on PATH"
        return result

    work_root = out_dir / f"_{label}"
    shutil.rmtree(work_root, ignore_errors=True)
    work_root.mkdir(parents=True, exist_ok=True)

    result.load_seconds = _marker_startup_s(threads, disable_ocr)
    print(f"    model load ~{result.load_seconds:.1f}s (blank page)", flush=True)

    for index, doc in enumerate(docs):
        with tempfile.TemporaryDirectory() as tmp:
            staged = Path(tmp) / "in"
            staged.mkdir()
            shutil.copy2(doc, staged / doc.name)
            seconds, error, timed_out = _marker_invoke(
                staged,
                work_root / doc.stem,
                threads,
                disable_ocr,
                doc_timeout_s,
                out_dir / f"{label}.{doc.stem}.failure.log",
            )
        items = [] if error else _marker_items(work_root / doc.stem, doc)
        result.docs.append(
            DocResult(
                name=doc.name,
                pages=page_count(doc, items),
                seconds=seconds,
                items=items,
                error=error or ("" if items else "no output produced"),
            )
        )
        print(f"    {doc.name}: {seconds:.1f}s {error}".rstrip(), flush=True)
        if timed_out:
            result.docs.extend(_skipped(docs[index + 1 :]))
            break
    return result


# -------------------------------------------------------------------- mineru


def _mineru_do_parse(do_parse: Any, read_fn: Any, doc: Path, work_out: Path) -> str:
    stem = f"doc_{uuid.uuid4().hex[:8]}"
    do_parse(
        output_dir=str(work_out),
        pdf_file_names=[stem],
        pdf_bytes_list=[read_fn(doc)],
        p_lang_list=[MINERU_LANG],
        backend="pipeline",
        parse_method="auto",
        f_draw_layout_bbox=False,
        f_draw_span_bbox=False,
        f_dump_middle_json=False,
        f_dump_model_output=False,
        f_dump_orig_pdf=False,
    )
    return stem


def _mineru_warmup_s(do_parse: Any, read_fn: Any) -> float:
    """Load MinerU's layout, OCR, table and formula weights on a blank page."""
    with tempfile.TemporaryDirectory() as tmp:
        blank = blank_pdf(Path(tmp) / "in")
        if blank is None:
            return 0.0
        started = time.perf_counter()
        try:
            _mineru_do_parse(do_parse, read_fn, blank, Path(tmp) / "out")
        except Exception:  # noqa: BLE001, S110 — warmup failure is not fatal
            pass
        return time.perf_counter() - started


def run_mineru(
    docs: list[Path], out_dir: Path, threads: int, *, doc_timeout_s: float
) -> BackendResult:
    """MinerU's `pipeline` backend on CPU — the incumbent, unported.

    This is the control in the experiment. It is MinerU's CPU pipeline
    backend with ``MINERU_DEVICE_MODE=cpu``, so if it is fast enough here the
    cheapest migration is no parser change at all: same ``content_list``, same
    bboxes, same ``parser_version`` scheme, no adapter, no re-tuned figure
    filters.

    Parsed one document at a time on purpose. Production batches several into a
    single call for cross-document page batching, so this understates MinerU's
    throughput under load — but per-document latency is the number that has to
    fit inside a job lease and a progress bar, and it is the only figure that
    compares directly to the Docling runs.

    ``doc_timeout_s`` cannot interrupt a call already inside MinerU, so it is
    checked between documents: one document blowing past the budget stops the
    backend instead of the whole run.
    """
    result = BackendResult(backend="mineru-pipeline-cpu", version=version_of("mineru"))
    try:
        from mineru.cli.common import do_parse, read_fn
    except Exception as exc:  # noqa: BLE001 — wrong image, report and move on
        result.error = f"import failed (use Dockerfile.mineru): {exc}"
        return result

    result.load_seconds = _mineru_warmup_s(do_parse, read_fn)
    print(f"    model load ~{result.load_seconds:.1f}s (blank page)", flush=True)

    for index, doc in enumerate(docs):
        started = time.perf_counter()
        try:
            with tempfile.TemporaryDirectory() as work:
                work_out = Path(work) / "out"
                work_out.mkdir(parents=True, exist_ok=True)
                stem = _mineru_do_parse(do_parse, read_fn, doc, work_out)
                elapsed = time.perf_counter() - started
                matches = list(work_out.rglob(f"{stem}_content_list.json"))
                if not matches:
                    raise RuntimeError("mineru produced no content list")
                payload = json.loads(matches[0].read_text(encoding="utf-8"))
                items = normalize.from_mineru(payload)
            result.docs.append(
                DocResult(
                    name=doc.name,
                    pages=page_count(doc, items),
                    seconds=elapsed,
                    items=items,
                )
            )
        except Exception as exc:  # noqa: BLE001 — one bad document, keep the rest
            result.docs.append(
                DocResult(
                    name=doc.name,
                    pages=page_count(doc),
                    seconds=time.perf_counter() - started,
                    error=str(exc)[:400],
                )
            )
        last = result.docs[-1]
        print(f"    {doc.name}: {last.seconds:.1f}s {last.error}".rstrip(), flush=True)
        if last.seconds > doc_timeout_s:
            print(f"    over {doc_timeout_s:.0f}s budget; stopping", flush=True)
            result.docs.extend(_skipped(docs[index + 1 :]))
            break
    return result


# ------------------------------------------------------------------- docling


def run_docling(
    docs: list[Path],
    out_dir: Path,
    threads: int,
    *,
    do_ocr: bool,
    do_tables: bool,
    do_formula: bool,
    doc_timeout_s: float,
    force_ocr: bool = False,
) -> BackendResult:
    label = "docling-" + ("ocr" if do_ocr else ("tables" if do_tables else "textonly"))
    if force_ocr:
        label = "docling-ocr-fullpage"
    if do_formula:
        label += "+formula"
    result = BackendResult(backend=label, version=version_of("docling"))

    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import (
            AcceleratorDevice,
            AcceleratorOptions,
            PdfPipelineOptions,
        )
        from docling.document_converter import DocumentConverter, PdfFormatOption
    except Exception as exc:  # noqa: BLE001 — report, do not abort other backends
        result.error = f"import failed: {exc}"
        return result

    try:
        options = PdfPipelineOptions()
        options.do_ocr = do_ocr
        options.do_table_structure = do_tables
        if do_ocr:
            # Docling defaults to EasyOCR, which is torch-based and the slowest
            # CPU option by a wide margin. RapidOCR is onnxruntime and a fairer
            # representative of "OCR on a CPU VM" — fall back only if missing.
            try:
                from docling.datamodel.pipeline_options import RapidOcrOptions

                options.ocr_options = RapidOcrOptions()
                label += "(rapid)"
                result.backend = label
            except Exception:  # noqa: BLE001 — fall back to Docling's default engine
                label += "(easyocr)"
                result.backend = label
            # Docling only OCRs bitmap regions by default, so on a born-digital
            # PDF `do_ocr=True` costs almost nothing and measures nothing. Forcing
            # full-page OCR is the only way to price the scanned-document case.
            # `force_full_page_ocr` still exists but is deprecated and (as of
            # 2.120) reading it does not actually switch the mode, so go through
            # OcrMode when the enum is available.
            if force_ocr:
                applied = False
                try:
                    from docling.datamodel.pipeline_options import OcrMode

                    options.ocr_options.mode = OcrMode.FULL_PAGE
                    applied = True
                except Exception:  # noqa: BLE001 — older releases lack the enum
                    if hasattr(options.ocr_options, "force_full_page_ocr"):
                        options.ocr_options.force_full_page_ocr = True
                        applied = True
                if not applied:
                    result.error = (
                        "could not force full-page OCR; result would be meaningless"
                    )
                    return result
        if do_tables:
            options.table_structure_options.do_cell_matching = True
        # Enrichment models are the expensive per-region ones; off unless asked.
        for attr in ("do_formula_enrichment", "do_code_enrichment"):
            if hasattr(options, attr):
                setattr(options, attr, do_formula and attr.startswith("do_formula"))
        options.accelerator_options = AcceleratorOptions(
            num_threads=max(1, threads), device=AcceleratorDevice.CPU
        )
        converter = DocumentConverter(
            format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)}
        )
    except Exception as exc:  # noqa: BLE001
        result.error = f"converter setup failed: {exc}"
        return result

    # Constructing the converter costs nothing; Docling loads layout, table and
    # OCR weights on the first convert. Burn that on a blank page so the first
    # real document is not silently charged for it.
    with tempfile.TemporaryDirectory() as tmp:
        blank = blank_pdf(Path(tmp))
        if blank is not None:
            started = time.perf_counter()
            try:
                converter.convert(str(blank))
            except Exception:  # noqa: BLE001, S110 — warmup failure is not fatal
                pass
            result.load_seconds = time.perf_counter() - started
            print(
                f"    model load ~{result.load_seconds:.1f}s (blank page)", flush=True
            )

    for index, doc in enumerate(docs):
        started = time.perf_counter()
        try:
            converted = converter.convert(str(doc))
            items = normalize.from_docling(converted.document)
            elapsed = time.perf_counter() - started
            result.docs.append(
                DocResult(
                    name=doc.name,
                    pages=page_count(doc, items),
                    seconds=elapsed,
                    items=items,
                )
            )
        except Exception as exc:  # noqa: BLE001
            result.docs.append(
                DocResult(
                    name=doc.name,
                    pages=page_count(doc),
                    seconds=time.perf_counter() - started,
                    error=str(exc)[:400],
                )
            )
        last = result.docs[-1]
        print(f"    {doc.name}: {last.seconds:.1f}s {last.error}".rstrip(), flush=True)
        if last.seconds > doc_timeout_s:
            print(f"    over {doc_timeout_s:.0f}s budget; stopping", flush=True)
            result.docs.extend(_skipped(docs[index + 1 :]))
            break
    return result


# --------------------------------------------------------------------- report


def summarize(results: list[BackendResult], threads: int) -> dict[str, Any]:
    rows = []
    for result in results:
        ok = [d for d in result.docs if d.items and not d.error]
        pages = sum(d.pages for d in ok)
        seconds = sum(d.seconds for d in ok)
        merged = metrics([item for d in ok for item in d.items])
        rows.append(
            {
                "backend": result.backend,
                "version": result.version,
                "error": result.error,
                "docs_ok": len(ok),
                "docs_failed": len(result.docs) - len(ok),
                "pages": pages,
                "seconds": round(seconds, 2),
                "pages_per_sec": round(pages / seconds, 2) if seconds > 0 else 0.0,
                "pages_per_sec_per_vcpu": round(pages / seconds / threads, 3)
                if seconds > 0
                else 0.0,
                "model_load_s": round(result.load_seconds, 1),
                **merged,
                "per_doc": [
                    {
                        "name": d.name,
                        "pages": d.pages,
                        "seconds": round(d.seconds, 2),
                        "pages_per_sec": round(d.pages / d.seconds, 2)
                        if d.seconds > 0
                        else 0.0,
                        "error": d.error,
                        **metrics(d.items),
                    }
                    for d in result.docs
                ],
            }
        )
    return {"threads": threads, "backends": rows}


def print_table(summary: dict[str, Any]) -> None:
    headers = [
        "backend",
        "pg/s",
        "pg/s/cpu",
        "pages",
        "blocks",
        "head",
        "depth",
        "infer",
        "tbl",
        "eq",
        "img",
        "bbox%",
        "fail",
    ]
    widths = [24, 7, 9, 6, 7, 5, 6, 6, 5, 4, 5, 6, 5]
    print("\n" + "  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("  ".join("-" * w for w in widths))
    for row in summary["backends"]:
        if row["error"]:
            print(f"{row['backend'].ljust(24)}  FAILED: {row['error'][:120]}")
            continue
        cells = [
            row["backend"],
            f"{row['pages_per_sec']:.2f}",
            f"{row['pages_per_sec_per_vcpu']:.3f}",
            str(row["pages"]),
            str(row["blocks"]),
            str(row["headings"]),
            str(row["heading_depth"]),
            str(row["headings_inferred_level"]),
            str(row["tables"]),
            str(row["equations"]),
            str(row["images"]),
            f"{row['bbox_coverage'] * 100:.0f}%",
            str(row["docs_failed"]),
        ]
        print("  ".join(c.ljust(w) for c, w in zip(cells, widths)))
    print(
        "\nhead=heading blocks  depth=distinct text_level values  "
        "infer=headings whose level had to be guessed (lower is better)"
    )


def probe() -> None:
    print("marker-pdf:", version_of("marker-pdf"))
    print("docling:   ", version_of("docling"))
    print("torch:     ", version_of("torch"))
    if shutil.which("marker"):
        proc = subprocess.run(
            ["marker", "--help"], capture_output=True, text=True, check=False
        )
        print("\n--- marker --help ---\n" + (proc.stdout or proc.stderr))
    else:
        print("\nmarker CLI not on PATH")


# ----------------------------------------------------------------------- main


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docs", default="/bench/docs")
    parser.add_argument("--out", default="/out")
    parser.add_argument(
        "--threads",
        type=int,
        default=4,
        help="Match this to --cpus on docker run, or the numbers are meaningless.",
    )
    parser.add_argument("--backends", default="all")
    parser.add_argument(
        "--max-pages",
        type=int,
        default=0,
        help="Cap every PDF to its first N pages (0 = whole document).",
    )
    parser.add_argument(
        "--doc-timeout",
        type=float,
        default=420.0,
        help=(
            "Seconds allowed per document. Marker is killed at the limit; the "
            "in-process backends finish the document then stop the backend. "
            "Anything slower than this is already disqualified for the fast route."
        ),
    )
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()

    if args.probe:
        probe()
        return 0

    docs_dir = Path(args.docs)
    docs = (
        sorted(
            p
            for p in docs_dir.iterdir()
            if p.is_file() and p.suffix.lower() in SUPPORTED_SUFFIXES
        )
        if docs_dir.is_dir()
        else []
    )
    if not docs:
        print(
            f"no documents in {docs_dir}. Drop representative uploads there "
            "(lecture slides, a textbook chapter, a scan) or run fetch_samples.py.",
            file=sys.stderr,
        )
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"{len(docs)} document(s), {args.threads} thread(s)")

    if args.max_pages > 0:
        docs = truncate_docs(docs, args.max_pages, out_dir / "_capped")

    budget = float(args.doc_timeout)
    registry: dict[str, Callable[[], BackendResult]] = {
        "mineru-pipeline-cpu": lambda: run_mineru(
            docs, out_dir, args.threads, doc_timeout_s=budget
        ),
        "marker-fast-noocr": lambda: run_marker(
            docs, out_dir, args.threads, disable_ocr=True, doc_timeout_s=budget
        ),
        "marker-fast": lambda: run_marker(
            docs, out_dir, args.threads, disable_ocr=False, doc_timeout_s=budget
        ),
        "docling-textonly": lambda: run_docling(
            docs,
            out_dir,
            args.threads,
            do_ocr=False,
            do_tables=False,
            do_formula=False,
            doc_timeout_s=budget,
        ),
        "docling-tables": lambda: run_docling(
            docs,
            out_dir,
            args.threads,
            do_ocr=False,
            do_tables=True,
            do_formula=False,
            doc_timeout_s=budget,
        ),
        "docling-ocr": lambda: run_docling(
            docs,
            out_dir,
            args.threads,
            do_ocr=True,
            do_tables=True,
            do_formula=False,
            doc_timeout_s=budget,
        ),
        "docling-ocr-fullpage": lambda: run_docling(
            docs,
            out_dir,
            args.threads,
            do_ocr=True,
            do_tables=True,
            do_formula=False,
            doc_timeout_s=budget,
            force_ocr=True,
        ),
        "docling-formula": lambda: run_docling(
            docs,
            out_dir,
            args.threads,
            do_ocr=False,
            do_tables=True,
            do_formula=True,
            doc_timeout_s=budget,
        ),
    }

    wanted = (
        list(registry)
        if args.backends == "all"
        else [b.strip() for b in args.backends.split(",") if b.strip() in registry]
    )

    results: list[BackendResult] = []
    for name in wanted:
        print(f"\n=== {name} ===", flush=True)
        started = time.perf_counter()
        try:
            result = registry[name]()
        except Exception as exc:  # noqa: BLE001 — never lose the other backends
            result = BackendResult(backend=name, version="?", error=str(exc)[:400])
        print(f"    {time.perf_counter() - started:.1f}s wall", flush=True)
        if result.error:
            print(f"    error: {result.error[:300]}", flush=True)
        results.append(result)

        backend_dir = out_dir / result.backend / "content_list"
        backend_dir.mkdir(parents=True, exist_ok=True)
        for doc in result.docs:
            if doc.items:
                (backend_dir / f"{Path(doc.name).stem}.json").write_text(
                    json.dumps(doc.items, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )

    summary = summarize(results, args.threads)
    (out_dir / "summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print_table(summary)

    per_doc_spread = [
        row["pages_per_sec"] for row in summary["backends"] if row["pages_per_sec"] > 0
    ]
    if len(per_doc_spread) > 1:
        print(
            f"\nthroughput spread across backends: "
            f"{min(per_doc_spread):.2f}–{max(per_doc_spread):.2f} pg/s "
            f"(median {statistics.median(per_doc_spread):.2f})"
        )
    print(f"\nnormalized content_list + summary.json written to {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
