"""Select a prospective systematic browser sample without changing case contents."""

import hashlib
import json
from pathlib import Path

from benchmark import LANGUAGES, read_cases

HERE = Path(__file__).resolve().parent
INDICES = {1, 18, 34, 46}


def main():
    source = HERE / "corpus.jsonl"
    assert len(read_cases(source)) == 14000, "The reviewed core corpus must be complete"
    questions = [json.loads(line) for line in source.read_text(encoding="utf-8").splitlines()]
    selected = [q for q in questions if int(q["id"].split("-")[2]) in INDICES]
    cells = {(q["domain"], q["language"]) for q in selected}
    assert len(cells) == 56 and {q["language"] for q in selected} == LANGUAGES
    assert all(sum((q["domain"], q["language"]) == cell for q in selected) == 4 for cell in cells)
    target = HERE / "browser-core.jsonl"
    target.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in selected), encoding="utf-8")
    assert len(read_cases(target)) == 1120
    manifest = {"core_sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                "subset_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                "source_row_indices": sorted(INDICES), "question_versions": len(selected),
                "grading_cases": 1120, "purpose": "Browser runtime agreement and serial latency across all domains and languages; selected before the full model results."}
    (HERE / "browser_selection.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
