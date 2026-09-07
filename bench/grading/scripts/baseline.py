"""Measure a literal-point baseline to expose the controlled corpus's easy cases."""

import argparse
from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import unicodedata

from benchmark import digest, read_cases, report


def normalize(text):
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    assert not args.output.exists(), "Use a new output path for a new baseline run"
    cases = read_cases(args.dataset)
    config = {"model": "literal-point-baseline", "runtime": "deterministic-text-containment-v1",
              "implementation_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              "latency_measured": False, "explanation_generated": False,
              "rule": "NFKC, casefold and whitespace normalization; fraction of criterion strings literally contained in the answer. Punctuation, numbers and operators retained."}
    batch = digest({"config": config, "cases": [case["case_sha256"] for case in cases]})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.with_suffix(".manifest.jsonl").write_text(json.dumps({
        "batch": batch, "config": config, "dataset": str(args.dataset), "expected_cases": len(cases),
        "case_hashes": [case["case_sha256"] for case in cases]}) + "\n", encoding="utf-8")
    with args.output.open("w", encoding="utf-8") as output:
        for case in cases:
            criteria = case["rubrics"][1:]
            assert len(criteria) in {1, 2}
            answer = normalize(case["user_answer"])
            score = sum(normalize(point) in answer for point in criteria) / len(criteria)
            row = {key: case[key] for key in ("family", "language", "domain", "expected", "label_source",
                                              "answer_kind", "label_ambiguous", "source_kind", "matched_across_languages")}
            row.update(case_id=case["id"], case_sha256=case["case_sha256"], config=config, batch=batch,
                       run_key=digest({"case": case["case_sha256"], "config": config}),
                       challenge=case.get("challenge", "core"),
                       answer_language=case.get("answer_language", case["language"]), score=score, valid_score=True,
                       valid_output=True, strict_json=True, seconds=0,
                       reason="Deterministic literal containment; no explanation generated.")
            output.write(json.dumps(row, ensure_ascii=False) + "\n")
    with redirect_stdout(io.StringIO()):
        report(args.output)
    summary_path = args.output.with_suffix(".summary.json")
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    for group in summary:
        group.update(latency_measured=False, explanation_generated=False)
        for field in ("median_seconds", "p95_seconds", "valid_output_agreement", "invalid_outputs", "non_strict_json", "truncated"):
            group[field] = None
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps([group for group in summary if group["language"] == group["domain"] == "all"
                     and group["answer_kind"] == "primary"], indent=2))


if __name__ == "__main__":
    main()
