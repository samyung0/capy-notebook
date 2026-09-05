"""Preselect a balanced qualitative explanation audit before inspecting responses."""

import json
from pathlib import Path

from benchmark import digest, read_cases

HERE = Path(__file__).resolve().parent


def main():
    cases = [case for case in read_cases(HERE / "corpus.jsonl")
             if case["answer_kind"] != "reference_anchor" and not case["label_ambiguous"]]
    domains = sorted({case["domain"] for case in cases})
    selected = []
    for language_index, language in enumerate(sorted({case["language"] for case in cases})):
        for label_index, label in enumerate((0, 0.5, 1)):
            for offset in range(2):
                domain = domains[(language_index + label_index * 2 + offset) % len(domains)]
                choices = [case for case in cases if case["language"] == language
                           and case["domain"] == domain and case["expected"] == label]
                selected.append(min(choices, key=lambda case: digest([20260905, case["id"]])))
    assert len(selected) == len({case["id"] for case in selected}) == 42
    manifest = {"purpose": "Qualitative reason review; two cases per expected grade and language, with rotating domains. Not a prevalence estimate.",
                "selection_seed": 20260905,
                "cases": [{key: case[key] for key in ("id", "case_sha256", "language", "domain", "expected")} for case in selected]}
    (HERE / "explanation_selection.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Selected {len(selected)} cases for each model's explanation audit")


if __name__ == "__main__":
    main()
