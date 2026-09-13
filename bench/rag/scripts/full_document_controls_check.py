"""Verify source bytes and page anchors for the full-document locator controls."""

import argparse
import hashlib
import json
import unicodedata
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/rag/fixtures/full-document-controls.json"


def normalized(text):
    return "".join(unicodedata.normalize("NFKC", text).split())


def check(fixture_path):
    fixture = json.loads(fixture_path.read_text())
    sources = {source["source_id"]: source for source in fixture["sources"]}
    assert len(sources) == len(fixture["sources"]), "duplicate source ID"
    assert len({case["id"] for case in fixture["cases"]}) == len(fixture["cases"])
    pages = {}
    for source_id, source in sources.items():
        path = ROOT / source["pdf"]
        assert hashlib.sha256(path.read_bytes()).hexdigest() == source["sha256"]
        with pymupdf.open(path) as document:
            pages[source_id] = [page.get_text() for page in document]
    checked, raw_glyph_variants = [], []
    for case in fixture["cases"]:
        target = case["expected"]
        if target["outcome"] == "abstain":
            assert target["reason"]
            continue
        assert target["outcome"] == "resolve"
        source = sources[target["source_id"]]
        assert source["filename"] in case["query"]
        source_pages = pages[target["source_id"]]
        assert all(1 <= page <= len(source_pages) for page in target["physical_pages"])
        text = normalized(
            "".join(source_pages[p - 1] for p in target["physical_pages"])
        )
        anchors = target["anchors"]
        if "raw_glyph_anchor" in target:
            anchors = [target["raw_glyph_anchor"]]
            raw_glyph_variants.append(case["id"])
        assert anchors and all(normalized(anchor) in text for anchor in anchors), case[
            "id"
        ]
        checked.append(case["id"])
    return {
        "fixture_sha256": hashlib.sha256(fixture_path.read_bytes()).hexdigest(),
        "source_hashes_verified": len(sources),
        "positive_page_anchors_checked": checked,
        "raw_glyph_variants_checked_separately": raw_glyph_variants,
        "limit": "Checks source identity and anchor presence, not unique resolution, parser output, answer accuracy, or the semantic negative labels.",
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixture", type=Path, default=FIXTURE)
    args = parser.parse_args()
    print(json.dumps(check(args.fixture), ensure_ascii=False, indent=2))
