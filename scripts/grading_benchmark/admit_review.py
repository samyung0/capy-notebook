"""Apply a reviewed translation patch and record the exact admitted version."""

import argparse
import hashlib
import json
from pathlib import Path
import re

from benchmark import DATA


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("review", type=Path)
    args = parser.parse_args()
    review = json.loads(args.review.read_text(encoding="utf-8"))
    name = review["file"]
    assert re.fullmatch(r"[a-z_]+\.(es|fr|ja|ko|zh-Hans|zh-Hant)\.json", name), name
    domain, language, _ = name.rsplit(".", 2)
    here = Path(__file__).resolve().parent
    source = here / "seeds" / f"{domain}.en.json"
    draft = DATA / "translation-drafts" / name
    assert sha(source) == review["source_sha256"], "English source changed since review"
    assert sha(draft) == review["draft_sha256"], "Translation draft changed since review"
    rows = json.loads(draft.read_text(encoding="utf-8"))
    assert len(rows) == 50
    changed = set()
    for patch in review["patches"]:
        row, column, value = patch["row"], patch["column"], patch["text"]
        assert 1 <= row <= 50 and 0 <= column <= 4 and isinstance(value, str) and value.strip()
        assert (row, column) not in changed, "Duplicate patch coordinate"
        changed.add((row, column))
        rows[row - 1][column] = value
    assert all(len(r) == 5 and all(isinstance(v, str) and v.strip() for v in r) for r in rows)
    output = here / "seeds" / name
    text = "[\n" + ",\n".join("  " + json.dumps(r, ensure_ascii=False) for r in rows) + "\n]\n"
    output.write_text(text, encoding="utf-8")
    manifest = here / "reviewed_seeds.json"
    records = json.loads(manifest.read_text(encoding="utf-8"))
    records[name] = {"sha256": sha(output), "source_sha256": review["source_sha256"],
                     "draft_sha256": review["draft_sha256"], "author": "Codex English source; Qwen3.5-9B-Q4 translation draft",
                     "reviewer": review.get("reviewer", "independent Codex reviewer"), "translation": "reviewed",
                     "review_sha256": sha(args.review), "corrected_cells": len(changed),
                     "native_rows": review.get("native_rows", []), "notes": review["notes"]}
    manifest.write_text(json.dumps(records, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"file": name, "patches": len(changed), "sha256": sha(output)}))


if __name__ == "__main__":
    main()
