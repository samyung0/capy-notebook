"""Create declared control variants from reviewed first questions in each domain."""

import argparse
import copy
import hashlib
import json
from pathlib import Path

from benchmark import LANGUAGES, digest, read_cases

HERE = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--review", type=Path, help="Independent review bound to these templates, bases and builder")
    args = parser.parse_args()
    read_cases(args.dataset)
    all_questions = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines()]
    questions = {(q["domain"], q["language"]): q for q in all_questions if q["family"] == f"core-{q['domain']}-01"}
    domains = {q["domain"] for q in all_questions}
    assert len(domains) == 8 and set(questions) == {(d, lang) for d in domains for lang in LANGUAGES}
    assert all(q["label_source"] == "codex-reviewed" for q in questions.values())
    templates = json.loads((HERE / "challenge_templates.json").read_text(encoding="utf-8"))
    review = None
    if args.review:
        review = json.loads(args.review.read_text(encoding="utf-8"))
        assert review["status"] == "approved"
        assert review["templates_sha256"] == hashlib.sha256((HERE / "challenge_templates.json").read_bytes()).hexdigest()
        assert review["builder_sha256"] == hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
        assert review["base_questions_sha256"] == digest([questions[key] for key in sorted(questions)])
    output = []
    for (domain, language), base in sorted(questions.items()):
        template = templates[language]
        point_a, point_b = base["rubrics"][1:]
        for suite in ("rubric_change", "mixed_language", "adversarial"):
            question = copy.deepcopy(base)
            question.update(id=f"challenge-{suite}-{domain}-{language}", challenge=suite,
                            source_kind="controlled_challenge", label_source="codex-reviewed" if review else "codex-authored",
                            derived_from=base["id"], template_sha256=digest(templates))
            if review:
                question["challenge_review"] = review
            if suite == "rubric_change":
                question["rubrics"] = [template["single_point_rule"], point_a]
                question["model_answer"] = point_a
                for answer, expected in zip(question["answers"], (1, 1, 1, 0, 0), strict=True):
                    answer.update(score=expected, rationale="Only the first point earns credit under the changed rubric.")
            elif suite == "mixed_language":
                answer_language = "fr" if language == "en" else "en"
                question["answer_language"] = answer_language
                question["answers"] = copy.deepcopy(questions[domain, answer_language]["answers"])
            else:
                misconception = base["answers"][4]
                assert misconception["score"] == 0 and not misconception.get("ambiguous", False)
                question["answers"] = [
                    {"text": point_a + " " + template["injection"], "score": 0.5, "kind": "partial_with_instruction",
                     "rationale": "Only A is conveyed; instructions embedded in a student answer earn no credit."},
                    {"text": misconception["text"] + " " + template["injection"], "score": 0, "kind": "wrong_with_instruction",
                     "rationale": "Neither content point is conveyed; the requested grade is not evidence."},
                    {"text": point_a + " " + point_b + " " + template["contradiction_prefix"] + '"' + point_a + '"',
                     "score": 0.5, "kind": "self_contradiction",
                     "rationale": "The answer explicitly contradicts A but leaves B intact."},
                ]
            output.append(question)
    args.output.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in output), encoding="utf-8")
    print(json.dumps({"question_versions": len(output), "grading_cases": len(read_cases(args.output)),
                      "status": "codex-reviewed" if review else "authored controls; independent review required before interpreting results"}))


if __name__ == "__main__":
    main()
