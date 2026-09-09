"""Run version-bound native-geometry experiments through the existing benchmark.

Use one variant per fresh process in an isolated container. This adds hooks and
provenance without changing the shared comparison runner or production adapter.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import importlib.metadata
import importlib.util
import json
import sys
import threading
import time
from pathlib import Path

import compare_opendataloader as comparison

VARIANTS = {
    "baseline": (),
    "native-text": ("mineru_native_text",),
    "native-page": ("mineru_native_page",),
    "combined": ("mineru_native_text", "mineru_native_page"),
}


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, add_help=False)
    parser.add_argument("--variant", choices=VARIANTS, required=True)
    parser.add_argument("--capacity", action="store_true")
    options, rest = parser.parse_known_args()
    if "--config" in rest:
        parser.error("--variant supplies the configuration; omit --config")
    if importlib.metadata.version("mineru") != "3.4.5":
        raise RuntimeError("native geometry hooks require MinerU 3.4.5")

    # Read only the common output selectors; the original runner validates all
    # remaining arguments and rejects reuse of an existing output directory.
    selectors = argparse.ArgumentParser(add_help=False)
    selectors.add_argument("root", type=Path)
    selectors.add_argument("--run", required=True)
    selected, _ = selectors.parse_known_args(rest)
    output = selected.root / "results" / selected.run
    if output.exists():
        raise FileExistsError(output)
    started = time.monotonic()
    corpus = json.loads((selected.root / "corpus.json").read_text())
    verified = {}
    for entry in corpus["entries"]:
        source = selected.root / entry["pdf"]
        if str(source) not in verified:
            verified[str(source)] = digest(source)
        if verified[str(source)] != entry["pdf_sha256"]:
            raise ValueError(f"source hash mismatch: {entry['id']}")

    modules = [importlib.import_module(name) for name in VARIANTS[options.variant]]
    for module in modules:
        module.install()
    config_name = f"mineru-{options.variant}"
    comparison.CONFIGS[config_name] = {"engine": "mineru", "method": "auto"}
    original_measured = comparison.measured
    snapshot_lock = threading.Lock()
    snapshot_saved = False

    def measured(*args, **kwargs):
        nonlocal snapshot_saved
        with snapshot_lock:
            if not snapshot_saved:
                snapshot = output / "source-snapshot"
                snapshot.mkdir()
                for name, body in source_bytes.items():
                    (snapshot / name).write_bytes(body)
                comparison.save(output / "native-provenance.json", provenance)
                snapshot_saved = True
        before = {module.__name__: module.stats() for module in modules}
        record = original_measured(*args, **kwargs)
        record["native_work"] = {
            "before": before,
            "after": {module.__name__: module.stats() for module in modules},
            "scope": "process counters; intervals overlap in concurrent bursts",
        }
        comparison.save(args[2] / "result.json", record)
        return record

    comparison.measured = measured
    script_dir = Path(__file__).resolve().parent
    sources = [
        Path(__file__),
        script_dir / "compare_opendataloader.py",
        script_dir / "mineru_worker.py",
        *[Path(module.__file__) for module in modules],
    ]
    if options.capacity:
        sources.append(script_dir / "bench_opendataloader_capacity.py")
    package = Path(importlib.util.find_spec("mineru").origin).parent
    sources.extend(
        package / name
        for name in (
            "backend/pipeline/batch_analyze.py",
            "backend/pipeline/pipeline_analyze.py",
            "utils/pdf_text_tool.py",
            "utils/ocr_utils.py",
            "utils/span_pre_proc.py",
            "utils/bbox_utils.py",
            "utils/pdfium_guard.py",
        )
    )
    source_bytes = {path.name: path.read_bytes() for path in sources}
    provenance = {
        "variant": options.variant,
        "argv": sys.argv,
        "source_hashes": {
            name: hashlib.sha256(body).hexdigest()
            for name, body in source_bytes.items()
        },
        "verified_pdf_count": len(verified),
        "corpus_sha256": digest(selected.root / "corpus.json"),
        "versions": {
            name: importlib.metadata.version(name)
            for name in (
                "mineru",
                "torch",
                "onnxruntime",
                "pypdfium2",
                "pymupdf",
                "pdftext",
                "numpy",
                "opencv-python",
            )
        },
    }
    sys.argv = [sys.argv[0], *rest, "--config", config_name]
    try:
        if options.capacity:
            import bench_opendataloader_capacity

            bench_opendataloader_capacity.main()
        else:
            comparison.main()
    finally:
        if output.exists():
            provenance["total_process_work_s"] = time.monotonic() - started
            provenance["native_work"] = {
                module.__name__: module.stats() for module in modules
            }
            comparison.save(output / "native-provenance.json", provenance)
    failed = [
        str(path.parent)
        for path in output.glob("*/result.json")
        if json.loads(path.read_text())["state"] != "ok"
    ]
    if failed:
        raise RuntimeError(f"failed cases: {failed}")


if __name__ == "__main__":
    main()
