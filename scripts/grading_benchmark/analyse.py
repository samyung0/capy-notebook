"""Compare complete, hash-matched runs and export a fixed explanation review packet."""

import argparse
from collections import Counter, defaultdict
from itertools import combinations
import json
from pathlib import Path
import random
import statistics

from benchmark import digest, family_interval, metrics, read_cases, read_results


def primary(row):
    return row["answer_kind"] != "reference_anchor" and not row["label_ambiguous"]


def correct(row):
    return int(row["valid_score"] and row["score"] == row["expected"])


def load_complete(paths, cases, models):
    indexed = {case["id"]: case for case in cases}
    runs = {model: {} for model in models}
    identities = {}
    for path in paths:
        for row in read_results(path):
            model = row["config"]["model"]
            if model not in runs:
                continue
            identity = (digest(row["config"]), row["batch"])
            if identities.setdefault(model, identity) != identity:
                raise ValueError(f"Multiple configurations/batches for {model}; compare separately")
            case_id = row["case_id"]
            if case_id not in indexed or row["case_sha256"] != indexed[case_id]["case_sha256"]:
                raise ValueError(f"Dataset mismatch: {model}/{case_id}")
            for field in ("expected", "family", "language", "domain", "answer_kind", "label_ambiguous", "label_source",
                          "source_kind", "matched_across_languages"):
                if row[field] != indexed[case_id][field]:
                    raise ValueError(f"Result metadata mismatch: {model}/{case_id}/{field}")
            if (row.get("challenge", "core") != indexed[case_id].get("challenge", "core")
                    or row.get("answer_language", row["language"]) != indexed[case_id].get("answer_language", indexed[case_id]["language"])):
                raise ValueError(f"Result challenge/language metadata mismatch: {model}/{case_id}")
            existing = runs[model].get(case_id)
            if existing is not None and existing != row:
                raise ValueError(f"Conflicting repeated result: {model}/{case_id}")
            runs[model][case_id] = row
    for model, rows in runs.items():
        missing = set(indexed) - rows.keys()
        if missing:
            raise ValueError(f"Incomplete {model}: {len(rows)}/{len(indexed)}; first missing {min(missing)}")
    return runs


def describe(rows, interval=False):
    result = metrics(rows)
    result["invalid_scores"] = sum(not row["valid_score"] for row in rows)
    result["false_full_credit"] = sum(row["valid_score"] and row["score"] == 1 and row["expected"] < 1 for row in rows)
    result["not_full_credit_cases"] = sum(row["expected"] < 1 for row in rows)
    result["false_zero_credit"] = sum(row["valid_score"] and row["score"] == 0 and row["expected"] > 0 for row in rows)
    result["positive_credit_cases"] = sum(row["expected"] > 0 for row in rows)
    result["confusion"] = dict(Counter(f"{row['expected']:g}->{row['score']:g}" if row["valid_score"]
                                       else f"{row['expected']:g}->invalid" for row in rows))
    if interval:
        result["family_bootstrap_95"] = family_interval(rows)
    measured = rows[0]["config"]["runtime"] != "deterministic-text-containment-v1"
    result["latency_measured"] = measured
    if not measured:
        result["explanation_generated"] = False
        for field in ("median_seconds", "p95_seconds", "valid_output_agreement", "invalid_outputs", "non_strict_json", "truncated"):
            result[field] = None
    for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
        values = [row["response"]["usage"][field] for row in rows
                  if field in row.get("response", {}).get("usage", {})]
        result[field] = {"observations": len(values), "median": statistics.median(values), "max": max(values)} if values else None
    return result


def paired(left, right, key):
    """A positive accuracy difference favors left; missing/invalid grades never agree."""
    left_map = {key(row): row for row in left}
    right_map = {key(row): row for row in right}
    if len(left_map) != len(left) or len(right_map) != len(right) or left_map.keys() != right_map.keys():
        raise ValueError("Pairing requires equal, unique case keys")
    blocks = defaultdict(lambda: [0, 0])
    same_valid_score = both_valid = left_only = right_only = 0
    for case_key, a in left_map.items():
        b = right_map[case_key]
        if a["expected"] != b["expected"] or a["family"] != b["family"]:
            raise ValueError("Paired labels/families differ")
        a_correct, b_correct = correct(a), correct(b)
        blocks[a["family"]][0] += a_correct - b_correct
        blocks[a["family"]][1] += 1
        left_only += a_correct and not b_correct
        right_only += b_correct and not a_correct
        both_valid += a["valid_score"] and b["valid_score"]
        same_valid_score += a["valid_score"] and b["valid_score"] and a["score"] == b["score"]
    values = [blocks[family] for family in sorted(blocks)]
    rng = random.Random(20260905)
    estimates = []
    for _ in range(1000):
        sample = rng.choices(values, k=len(values))
        estimates.append(sum(value[0] for value in sample) / sum(value[1] for value in sample))
    estimates.sort()
    return {"cases": len(left), "families": len(blocks),
            "accuracy_difference": (sum(correct(row) for row in left) - sum(correct(row) for row in right)) / len(left),
            "family_bootstrap_95": [estimates[24], estimates[974]],
            "left_only_correct": left_only, "right_only_correct": right_only,
            "both_valid": both_valid, "same_valid_score": same_valid_score,
            "valid_score_consistency_all_pairs": same_valid_score / len(left),
            "valid_score_consistency_when_both_valid": same_valid_score / both_valid if both_valid else None}


def summarize(runs):
    output = {"method": "All requested cases required, with exact case hashes and one configuration/batch per model. Primary excludes reference anchors and pre-identified ambiguous labels. Family bootstrap: 1,000 draws, seed 20260905; unadjusted exploratory intervals, not independent human validation.",
              "models": {}, "model_pairs_primary": [], "language_pairs_primary_matched": []}
    primaries = {}
    for model, indexed in runs.items():
        rows = list(indexed.values())
        chosen = primaries[model] = [row for row in rows if primary(row)]
        groups = {"all": rows, "primary": chosen,
                  "primary_matched": [row for row in chosen if row["matched_across_languages"]],
                  "primary_native": [row for row in chosen if row["source_kind"] == "native"],
                  "reference_anchors": [row for row in rows if row["answer_kind"] == "reference_anchor"],
                  "ambiguous_labels": [row for row in rows if row["label_ambiguous"]]}
        entry = {"config": rows[0]["config"], "batch": rows[0]["batch"],
                 "groups": {name: describe(group, name in {"all", "primary", "primary_matched"}) for name, group in groups.items() if group}}
        for field in ("language", "domain", "answer_kind", "expected"):
            entry["primary_by_" + field] = {value: describe([row for row in chosen if row[field] == value])
                                           for value in sorted({row[field] for row in chosen})}
        entry["primary_by_language_domain"] = {f"{language}/{domain}": describe([row for row in chosen if row["language"] == language and row["domain"] == domain])
                                                 for language in sorted({row["language"] for row in chosen})
                                                 for domain in sorted({row["domain"] for row in chosen})
                                                 if any(row["language"] == language and row["domain"] == domain for row in chosen)}
        entry["challenges"] = {suite: {"all": describe([row for row in rows if row.get("challenge") == suite]),
                                        "primary": describe([row for row in chosen if row.get("challenge") == suite])}
                               for suite in sorted({row.get("challenge", "core") for row in rows} - {"core"})}
        output["models"][model] = entry
        matched = [row for row in groups["primary_matched"] if row.get("challenge", "core") == "core"]
        language_rows = {language: [row for row in matched if row["language"] == language]
                         for language in sorted({row["language"] for row in matched})}
        comparisons = [(language, "en") for language in language_rows if language != "en" and "en" in language_rows]
        if "zh-Hans" in language_rows and "zh-Hant" in language_rows:
            comparisons.append(("zh-Hant", "zh-Hans"))
        for left, right in comparisons:
            output["language_pairs_primary_matched"].append({"model": model, "left": left, "right": right,
                                                             **paired(language_rows[left], language_rows[right], lambda row: (row["family"], row.get("challenge", "core"), row["answer_kind"]))})
    for left, right in combinations(runs, 2):
        output["model_pairs_primary"].append({"left": left, "right": right,
                                              **paired(primaries[left], primaries[right], lambda row: row["case_id"])})
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    comparison = sub.add_parser("compare")
    explanation = sub.add_parser("explanations")
    for command in (comparison, explanation):
        command.add_argument("--dataset", type=Path, required=True)
        command.add_argument("--input", type=Path, nargs="+", required=True)
        command.add_argument("--models", nargs="+", required=True)
        command.add_argument("--output", type=Path, required=True)
    explanation.add_argument("--selection", type=Path, required=True)
    args = parser.parse_args()
    cases = read_cases(args.dataset)
    runs = load_complete(args.input, cases, args.models)
    if args.command == "compare":
        output = summarize(runs)
    else:
        if any(next(iter(run.values()))["config"]["runtime"] == "deterministic-text-containment-v1" for run in runs.values()):
            raise ValueError("The literal baseline generates no explanations; omit it from the review packet")
        selection = json.loads(args.selection.read_text(encoding="utf-8"))
        indexed = {case["id"]: case for case in cases}
        output = {"selection": selection, "review_instructions": "For each response, assess whether the reason identifies rubric evidence accurately, whether it supports its stated score, and whether it invents facts. Record specific vague, contradictory or unsupported reasoning. A different response language alone is not a failure: the prompt does not mandate one. This fixed, stratified sample is qualitative, not a prevalence estimate.", "cases": []}
        for selected in selection["cases"]:
            case = indexed[selected["id"]]
            if case["case_sha256"] != selected["case_sha256"]:
                raise ValueError("Stale explanation selection")
            output["cases"].append({"case": case, "responses": {model: {field: run[case["id"]].get(field) for field in ("score", "reason", "raw", "valid_score", "valid_output", "failure", "config", "batch")}
                                                                       for model, run in runs.items()}})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Saved {args.output}")


if __name__ == "__main__":
    main()
