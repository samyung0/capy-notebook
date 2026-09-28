"""Memory of one parse child, step by step, inside the parser image.

Runs ``app.run_document`` (what the parse child runs) on each document of a
manifest in one process, the way the persistent child sees a stream of
documents. Every refinement step ``refine.parse_pdf`` calls is wrapped; a
thread reads this process's RSS every 20 ms and credits the peak to the
outermost step running. After each document it records RSS with the result
still held, after dropping it and ``gc.collect()``, and after
``malloc_trim(0)`` (only with ``--trim``, since trimming changes what the next
document starts from).

    docker run --rm --network none -v /opt:/opt -e CAPY_PARSE_SHARED_DIR=/tmp/s \
      -e CAPY_PARSE_WORKERS=1 \
      --entrypoint python IMAGE /path/profile_parser_memory.py manifest.json out.jsonl [--trim] [--trace]

``--trace`` adds tracemalloc's peak per step (Python objects only; PyMuPDF and
onnxruntime allocate outside it) and slows the run down.
"""

from __future__ import annotations

import argparse
import ctypes
import gc
import json
import os
import pickle
import sys
import threading
import time
import tracemalloc
from pathlib import Path

sys.path.insert(0, "/app/parser")

import app  # noqa: E402
from odl import (  # noqa: E402
    columns,
    context,
    exponents,
    fonts,
    furniture,
    headings,
    hidden,
    java,
    levels,
    lists,
    ocr,
    order,
    outline_levels,
    pictures,
    refine,
    source_text,
    styles,
    tables,
)

# Every call parse_pdf makes, in its order (hidden.source_facts runs per page
# inside a comprehension and is left in the enclosing time).
STEPS = [
    (fonts, "repair_fonts"),
    (java, "run"),
    (styles, "annotate"),
    (refine, "odl_content_list"),
    (pictures, "classify"),
    (order, "repair"),
    (order, "move_rotated_labels"),
    (order, "split_continuations"),
    (hidden, "recover_hidden_ocr_order"),
    (headings, "source_headings"),
    (headings, "rewrite"),
    (headings, "correct_roles"),
    (context, "contextualize"),
    (tables, "mark_footer_tables"),
    (lists, "repair_list_geometry"),
    (source_text, "repair_text"),
    (lists, "repair_lists"),
    (exponents, "restore_exponents"),
    (columns, "repair_columns"),
    (source_text, "join_split_ligatures"),
    (furniture, "mark_page_numbers"),
    (levels, "demote_fragments"),
    (levels, "demote_contents_lines"),
    (outline_levels, "relevel"),
    (outline_levels, "mark_book_titles"),
    (furniture, "repeated_across_pages"),
    (tables, "recover_tables"),
    (fonts, "compose_negations"),
    (ocr, "add_ocr_text"),
]
PAGE = os.sysconf("SC_PAGE_SIZE")
MIB = 1 << 20


def rss() -> int:
    with open("/proc/self/statm", encoding="ascii") as statm:
        return int(statm.read().split()[1]) * PAGE


class Recorder:
    def __init__(self, trace: bool) -> None:
        self.trace = trace
        self.current: dict | None = None
        self.steps: list[dict] = []
        self.native_bytes = 0
        threading.Thread(target=self.sample, daemon=True).start()

    def sample(self) -> None:
        while True:
            step = self.current
            if step is not None:
                step["peak"] = max(step["peak"], rss())
            time.sleep(0.02)

    def wrap(self, module, name: str) -> None:
        original = getattr(module, name)
        label = f"{module.__name__.rsplit('.', 1)[-1]}.{name}"

        def wrapped(*args, **kwargs):
            if self.current is not None:  # nested: credit the outer step
                return original(*args, **kwargs)
            if self.trace:
                tracemalloc.reset_peak()
            before = rss()
            step = {"step": label, "rss_in": before, "peak": before}
            self.current = step
            started = time.perf_counter()
            try:
                result = original(*args, **kwargs)
            finally:
                self.current = None
                step["s"] = round(time.perf_counter() - started, 2)
                step["rss_out"] = rss()
                if self.trace:
                    step["traced_peak_mib"] = round(
                        tracemalloc.get_traced_memory()[1] / MIB
                    )
                self.steps.append(step)
            if label == "java.run":
                self.native_bytes = sum(
                    p.stat().st_size for p in Path(args[1]).glob("*.json")
                )
            return result

        setattr(module, name, wrapped)


def mib(value: int) -> int:
    return round(value / MIB)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("manifest")
    parser.add_argument("output")
    parser.add_argument("--trim", action="store_true")
    parser.add_argument("--trace", action="store_true")
    args = parser.parse_args()
    if args.trace:
        tracemalloc.start()
    recorder = Recorder(args.trace)
    for module, name in STEPS:
        recorder.wrap(module, name)
    libc = ctypes.CDLL("libc.so.6")
    start = rss()
    with open(args.output, "w", encoding="utf-8") as out:
        for doc in json.loads(Path(args.manifest).read_text()):
            recorder.steps = []
            before = rss()
            started = time.perf_counter()
            result = app.run_document(
                app.Document(Path(doc["path"]).read_bytes(), Path(doc["path"]).name)
            )
            elapsed = time.perf_counter() - started
            held = rss()
            pickled = len(pickle.dumps(result, protocol=pickle.HIGHEST_PROTOCOL))
            blocks = len(result["content_list"])
            result = None
            gc.collect()
            after_gc = rss()
            after_trim = None
            if args.trim:
                libc.malloc_trim(0)
                after_trim = rss()
            record = {
                "id": doc["id"],
                "pages": doc.get("pages"),
                "s": round(elapsed, 1),
                "blocks": blocks,
                "native_json_mib": mib(recorder.native_bytes),
                "result_pickle_mib": mib(pickled),
                "rss_process_start_mib": mib(start),
                "rss_before_mib": mib(before),
                "rss_peak_mib": mib(max(s["peak"] for s in recorder.steps)),
                "rss_result_held_mib": mib(held),
                "rss_after_gc_mib": mib(after_gc),
                "rss_after_trim_mib": None if after_trim is None else mib(after_trim),
                "steps": [
                    {
                        "step": s["step"],
                        "s": s["s"],
                        "in": mib(s["rss_in"]),
                        "peak": mib(s["peak"]),
                        "out": mib(s["rss_out"]),
                        **(
                            {"traced_peak": s["traced_peak_mib"]}
                            if "traced_peak_mib" in s
                            else {}
                        ),
                    }
                    for s in recorder.steps
                ],
            }
            out.write(json.dumps(record) + "\n")
            out.flush()
            print(
                json.dumps({k: v for k, v in record.items() if k != "steps"}),
                flush=True,
            )


if __name__ == "__main__":
    main()
