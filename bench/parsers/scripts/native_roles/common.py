"""Shared paths and helpers for the native role experiment."""

import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
FIX = REPO / "bench/parsers/fixtures"
BOOKS_JSON = FIX / "native-roles-books-2026-10-13.json"
CLASSMAP_JSON = FIX / "native-roles-classmap-2026-10-13.json"
OUT = Path(os.environ.get("NATIVE_ROLES_OUT", REPO / "bench/parsers/reports/local/2026-10-13-native-roles"))
POOL = OUT / "pool"  # <id>.pdf for every candidate book
REVIEW = REPO / "bench/parsers/reports/local/2026-10-12-mineru-v12"

# Our line roles. "heading" carries a separate level.
ROLES = ["body", "heading", "list", "caption", "footnote", "code", "furniture", "formula", "figure_label", "table_cell"]


def load_books() -> dict:
    return json.loads(BOOKS_JSON.read_text())


def pdf_path(book_id):
    return POOL / f"{book_id}.pdf"


def book_pdf(book_id):
    """Pool copy, or the review copy for the one review book above the upload limits."""
    p = POOL / f"{book_id}.pdf"
    return p if p.exists() else REVIEW / "books" / f"{book_id}.pdf"


def selected_pages(splits=("train", "heldout", "review")):
    """(book, 0-based page) for every labelled page, in manifest order."""
    m = load_books()
    out = []
    for b in m["books"]:
        if b["split"] in splits:
            out += [(b["id"], p) for p in b["sample_pages"]]
    if "review" in splits:
        out += [(r["id"], p) for r in m["review_pages"] for p in r["pages"]]
    return list(dict.fromkeys(out))
