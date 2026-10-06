"""Arm B of the intake comparison: MinerU zip -> corpus -> index -> publish, per book.

For every book whose MinerU parse has finished (`<mineru>/<book>/done` holds
the wall seconds), this runs the converter (`mineru_corpus.py`), the pilot
index stage against arm B's own pilot database, and the library loader into
the scratch library. Each step is skipped when its receipt exists, so the
script is resumable. Nothing here touches the live pilot database or the live
library: the pilot config and LIBRARY_DATABASE_URL point at the two scratch
containers (15446 and 15445).

    uv run --project pipeline --with pymupdf==1.28.2 python \\
        bench/rag/intake/scripts/armb_pipeline.py [--book ahss4] [--only convert|index|publish]
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
EVAL = ROOT / "bench/rag/reports/local/2026-10-intake-eval"
MINERU = EVAL / "mineru"
RUNS = EVAL / "mineru-run"
CONFIG = EVAL / "mineru-pilot-config.json"
SCRATCH_LIBRARY = "postgresql://postgres:intake@127.0.0.1:15445/capy_library"
BOOKS = ["ahss4", "os4", "lsj", "brief-calculus", "fundamentals-of-electrical-engineering-i"]
PY = [sys.executable]


def run(cmd: list[str], log: Path, env: dict[str, str] | None = None) -> None:
    log.parent.mkdir(parents=True, exist_ok=True)
    with log.open("a", encoding="utf-8") as handle:
        handle.write("$ " + " ".join(cmd) + "\n")
        handle.flush()
        result = subprocess.run(cmd, stdout=handle, stderr=subprocess.STDOUT, env=env, cwd=ROOT, check=False)
    if result.returncode != 0:
        raise SystemExit(f"{cmd[1:3]} failed ({result.returncode}); see {log}")


def build(book: str, only: str | None) -> dict:
    done = MINERU / book / "done"
    if not done.exists():
        return {"book": book, "skipped": "parse not finished"}
    zips = list((MINERU / book / "out").glob("*.zip"))
    if len(zips) != 1:
        raise SystemExit(f"{book}: expected one zip under {MINERU / book / 'out'}, found {len(zips)}")
    run_dir = RUNS / book
    log = run_dir / "armb.log"
    report: dict = {"book": book}
    corpus = run_dir / "books" / book / "corpus.json"
    if (only in (None, "convert")) and not corpus.exists():
        run(
            PY
            + [
                str(ROOT / "bench/rag/intake/scripts/mineru_corpus.py"),
                "--run", str(run_dir), "--book", book, "--zip", str(zips[0]),
                "--parse-seconds", done.read_text().strip(),
            ],
            log,
        )
        report["converted"] = True
    if (only in (None, "index")) and corpus.exists() and not (run_dir / "index.json").exists():
        run(
            PY
            + [
                str(ROOT / "bench/rag/scripts/knowledge_base_pilot.py"), "index",
                "--manifest", str(run_dir / "manifest.json"), "--config", str(CONFIG),
                "--run", str(run_dir), "--secrets", str(ROOT / ".env.local"),
            ],
            log,
        )
        report["indexed"] = True
    receipt = run_dir / "library-publish.json"
    if (only in (None, "publish")) and (run_dir / "index.json").exists() and not receipt.exists():
        env = {**os.environ, "LIBRARY_DATABASE_URL": SCRATCH_LIBRARY}
        run(
            PY
            + [
                str(ROOT / "bench/rag/scripts/knowledge_base_library.py"), "publish",
                "--run", str(run_dir), "--manifest", str(run_dir / "manifest.json"),
                "--config", str(CONFIG), "--book", book,
                "--note", "arm B of the 2026-10-06 intake comparison: MinerU 4.0 standard, untagged",
            ],
            log,
            env,
        )
        receipt.write_text(json.dumps({"published": True}) + "\n", encoding="utf-8")
        report["published"] = True
    if corpus.exists():
        data = json.loads(corpus.read_text(encoding="utf-8"))
        report.update(chunks=len(data["chunks"]), excerpts=len(data["excerpts"]), figures=len(data["figures"]), parse_seconds=data["metrics"]["parse_seconds"])
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--book", choices=BOOKS)
    parser.add_argument("--only", choices=["convert", "index", "publish"])
    args = parser.parse_args()
    for book in [args.book] if args.book else BOOKS:
        print(json.dumps(build(book, args.only), ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
