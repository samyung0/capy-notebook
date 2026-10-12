"""Whole-book parses with the shipped parser (parser/odl, v13) for the held-out books.

usage: <parser venv>/bin/python parse_v13.py
Needs CAPY_RAPIDOCR_MODEL_DIR. Review books reuse the 2026-10-12 whole-book parses.
Writes OUT/v13/<book>/{content_list.json, refinement.json, result.json}.
"""

import json
import shutil
import sys
import time

from common import OUT, REPO, REVIEW, book_pdf, load_books

sys.path.insert(0, str(REPO / "parser"))
from odl.refine import parse_pdf  # noqa: E402

if __name__ == "__main__":
    for b in load_books()["books"]:
        if b["split"] != "heldout" or (REVIEW / "v13/odl/book" / b["id"] / "content_list.json").exists():
            continue
        d = OUT / "v13" / b["id"]
        if (d / "result.json").exists():
            continue
        shutil.rmtree(d, ignore_errors=True)
        (d / "work").mkdir(parents=True)
        t = time.perf_counter()
        p = parse_pdf(book_pdf(b["id"]).read_bytes(), d / "work", java_timeout_s=3600)
        (d / "content_list.json").write_text(json.dumps(p.content_list, ensure_ascii=False))
        (d / "refinement.json").write_text(json.dumps({"furniture": p.furniture}))
        shutil.rmtree(d / "work", ignore_errors=True)
        r = dict(book=b["id"], pages=p.page_count, seconds=round(time.perf_counter() - t, 1))
        (d / "result.json").write_text(json.dumps(r))
        print(json.dumps(r), flush=True)
