"""Expand explicitly authored two-criterion questions into five grading cases."""

import argparse
import hashlib
import json
from pathlib import Path

from benchmark import LANGUAGES, read_cases

HERE = Path(__file__).resolve().parent
RULES = {
    "en": "Award 0.5 for each of the following two points explicitly conveyed, up to 1. Accept equivalent wording. A point contradicted by the answer earns no credit. Do not infer an unstated point just from the question.",
    "es": "Otorga 0,5 por cada uno de los dos puntos siguientes expresado explícitamente, hasta 1. Acepta formulaciones equivalentes. Un punto contradicho por la respuesta no recibe crédito. No deduzcas un punto omitido solo a partir de la pregunta.",
    "fr": "Accorde 0,5 pour chacun des deux points suivants explicitement exprimé, jusqu'à 1. Accepte les formulations équivalentes. Un point contredit par la réponse ne rapporte rien. Ne déduis pas un point absent à partir de la seule question.",
    "ja": "次の2点をそれぞれ明示できていれば0.5点ずつ、合計1点とする。同じ意味の言い換えも認める。答案内で矛盾する点には加点しない。問題文だけから答案に書かれていない点を補わない。",
    "ko": "아래 두 가지 내용을 명시적으로 전달하면 각각 0.5점씩, 최대 1점을 준다. 같은 의미의 표현도 인정한다. 답안이 해당 내용을 부정하면 그 항목에는 점수를 주지 않는다. 문제만 보고 답안에 없는 내용을 추론하여 보충하지 않는다.",
    "zh-Hans": "以下两点，每明确表达一点得0.5分，合计最高1分。接受意思相同的表述。答案中自相矛盾的要点不得分。不得仅根据题目推断答案中未写出的要点。",
    "zh-Hant": "以下兩點，每明確表達一點得0.5分，合計最高1分。接受意思相同的表述。答案中自相矛盾的要點不得分。不得僅根據題目推斷答案中未寫出的要點。",
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--require-complete", action="store_true", help="Reject incomplete coverage or review before a final run")
    parser.add_argument("--output", type=Path, default=HERE / "corpus.jsonl")
    args = parser.parse_args()
    plan = json.loads((HERE / "curriculum.json").read_text(encoding="utf-8"))
    reviews = json.loads((HERE / "reviewed_seeds.json").read_text(encoding="utf-8"))
    exceptions = json.loads((HERE / "label_exceptions.json").read_text(encoding="utf-8"))
    for name, expected_hash in exceptions["source_sha256"].items():
        assert hashlib.sha256((HERE / "seeds" / name).read_bytes()).hexdigest() == expected_hash, f"Label audit is stale: {name}"
    out = args.output
    questions = []
    coverage = {}
    used_exceptions = set()
    for path in sorted((HERE / "seeds").glob("*.json")):
        domain, language, _ = path.name.rsplit(".", 2)
        assert domain in plan["domains"] and language in LANGUAGES
        rows = json.loads(path.read_text(encoding="utf-8"))
        review = reviews.get(path.name)
        if review:
            assert review["sha256"] == hashlib.sha256(path.read_bytes()).hexdigest(), f"Review is stale: {path}"
            if language != "en":
                source = HERE / "seeds" / f"{domain}.en.json"
                assert review["source_sha256"] == hashlib.sha256(source.read_bytes()).hexdigest(), f"Translation source review is stale: {path}"
        if language != "en" or args.require_complete:
            assert review, f"Translation must be reviewed before inclusion: {path}"
        native_path = HERE / "native" / path.name
        native_rows = {}
        native_review = None
        if native_path.is_file():
            native_review = reviews.get("native/" + path.name)
            assert native_review and native_review["sha256"] == hashlib.sha256(native_path.read_bytes()).hexdigest(), f"Missing or stale native-language review: {native_path}"
            native_data = json.loads(native_path.read_text(encoding="utf-8"))
            assert native_data["language"] == language
            native_rows = {r["row"]: r for r in native_data["rows"]}
            assert len(native_rows) == len(native_data["rows"]) and all(1 <= i <= len(rows) for i in native_rows)
        if args.require_complete and domain == "language_literature" and language != "en":
            assert len(native_rows) == 8, f"Expected eight reviewed native-language adaptations: {native_path}"
        coverage[f"{domain}/{language}"] = len(rows)
        for index, row in enumerate(rows, 1):
            if index in native_rows:
                row = native_rows[index]["values"]
            assert len(row) == 5 and all(isinstance(x, str) and x.strip() for x in row), path
            prompt, point_a, point_b, paraphrase, incorrect = row
            assert len({point_a, point_b, paraphrase, incorrect}) == 4, (path, index)
            reference = point_a + " " + point_b
            native = index in native_rows
            family_language = "zh" if language in {"zh-Hans", "zh-Hant"} else language
            family = f"native-{domain}-{index:02d}-{family_language}" if native else f"core-{domain}-{index:02d}"
            question = {
                "id": f"core-{domain}-{index:02d}-{language}", "family": family,
                "domain": domain, "language": language, "split": "test", "label_source": "codex-reviewed" if review else "codex-authored",
                "source_kind": "native" if native else "original" if language == "en" else "matched_translation",
                "seed_source": path.name, "review": review,
                "topic": native_rows[index]["topic"] if native else plan["domains"][domain][index - 1], "prompt": prompt,
                "rubrics": [RULES[language], point_a, point_b], "model_answer": reference,
                "answers": [
                    {"text": reference, "score": 1, "kind": "reference_anchor", "rationale": "Both explicitly required points are stated."},
                    {"text": paraphrase, "score": 1, "kind": "paraphrase", "rationale": "Both required points are conveyed using different wording."},
                    {"text": point_a, "score": 0.5, "kind": "partial_a", "rationale": "Only the first required point is explicitly conveyed."},
                    {"text": point_b, "score": 0.5, "kind": "partial_b", "rationale": "Only the second required point is explicitly conveyed."},
                    {"text": incorrect, "score": 0, "kind": "misconception", "rationale": "Neither required point is correctly conveyed."},
                ],
            }
            if native:
                question.update(native_source="native/" + path.name, native_review=native_review)
            for answer in question["answers"]:
                exception_key = f"{domain}/{index}/{answer['kind']}"
                correction = exceptions["cases"].get(exception_key)
                if correction:
                    assert not native, "A native adaptation needs its own label review"
                    answer.update(correction)
                    answer["label_exception_review"] = exceptions["reviewer"]
                    used_exceptions.add(exception_key)
            questions.append(question)
    expected = {f"{d}/{language}": 50 for d in plan["domains"] for language in LANGUAGES}
    if args.require_complete:
        assert coverage == expected, f"Incomplete coverage: {coverage}"
        assert used_exceptions == set(exceptions["cases"]), "Unused label exception"
    family_languages = {}
    for question in questions:
        family_languages.setdefault(question["family"], set()).add(question["language"])
    for question in questions:
        question["matched_across_languages"] = family_languages[question["family"]] == LANGUAGES
    out.write_text("".join(json.dumps(q, ensure_ascii=False) + "\n" for q in questions), encoding="utf-8")
    cases = read_cases(out)
    print(json.dumps({"question_versions": len(questions), "grading_cases": len(cases), "coverage": coverage}, indent=2))


if __name__ == "__main__":
    main()
