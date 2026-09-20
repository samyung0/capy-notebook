"""Probe typesafe.ai jev as a step-checking judge for open math answers.

Sends each fixture answer three times: state {question, user_answer} alone, with a
final-answer-only correct_answer, and with a full worked correct_answer, and asks three questions in the same request:
a noul "fully correct", its inverse "has an error", and a 3-level score mirroring
the app's 0 / 0.5 / 1 award. Raw responses go to data/grading-benchmark/runs/.

    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py
    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py equiv
    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py units
    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py algebra
    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py rubric
    TYPESAFE_API_KEY=... python bench/grading/scripts/typesafe_math.py route

equiv, units and algebra skip the working and ask only whether the user's final
answer is the same value as the reference in another form: units covers one
family per conversion kind (decimal shift, non-10 factor, formula, approximate),
algebra covers expression rewrites (rational, trig, log, radical, roots, intervals).
rubric grades open answers the way the app does, one noul per marking point and no
model answer, over 16 hand-written multi-rubric essays and the 8 English seed files.
route asks whether grading a question needs calculation or derivation checking, from
the question alone, with the model answer, and with model answer plus rubrics.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/grading/fixtures/typesafe_math_cases.json"
OUT = ROOT / "data/grading-benchmark/runs/typesafe-math.jsonl"
EQUIV_FIXTURE = ROOT / "bench/grading/fixtures/typesafe_equiv_cases.json"
EQUIV_OUT = ROOT / "data/grading-benchmark/runs/typesafe-equiv.jsonl"
UNITS_FIXTURE = ROOT / "bench/grading/fixtures/typesafe_units_cases.json"
UNITS_OUT = ROOT / "data/grading-benchmark/runs/typesafe-units.jsonl"
ALGEBRA_FIXTURE = ROOT / "bench/grading/fixtures/typesafe_algebra_cases.json"
ALGEBRA_OUT = ROOT / "data/grading-benchmark/runs/typesafe-algebra.jsonl"
RUBRIC_FIXTURE = ROOT / "bench/grading/fixtures/typesafe_rubric_cases.json"
SEEDS = ROOT / "bench/grading/fixtures/seeds"
EXCEPTIONS = ROOT / "bench/grading/fixtures/label_exceptions.json"
RUBRIC_OUT = ROOT / "data/grading-benchmark/runs/typesafe-rubric.jsonl"
ROUTE_FIXTURE = ROOT / "bench/grading/fixtures/typesafe_route_cases.json"
ROUTE_OUT = ROOT / "data/grading-benchmark/runs/typesafe-route.jsonl"
URL = "https://api.typesafe.ai/v1/systemone"

QUESTIONS = {
    "correct": {
        "type": "noul",
        "instructions": "The user_answer is a fully correct solution to the question: the final result is right and every calculation and reasoning step is accurate.",
        "criteria": {
            "true": "Every number, sign, identity and step is correct and the final result is correct.",
            "false": "Any step contains a wrong number, wrong sign or invalid reasoning, or the final result is wrong.",
        },
    },
    "has_error": {
        "type": "noul",
        "instructions": "At least one step in the user_answer contains a wrong number, wrong sign or an invalid calculation.",
    },
    "award": {
        "type": "score",
        "instructions": "How correct is the user_answer?",
        "criteria": [
            "The final result is wrong or the reasoning is invalid.",
            "The final result is right but at least one intermediate step contains an error.",
            "Every step and the final result are correct.",
        ],
    },
}

EQUIV_QUESTIONS = {
    "same": {
        "type": "noul",
        "instructions": "The user_answer expresses the same value as the correct_answer, allowing a different but equivalent form, notation or unit.",
        "criteria": {
            "true": "Same quantity or expression: equivalent fraction/decimal/percent, expanded/factored form, reordered terms, converted unit, or with/without a variable label.",
            "false": "A different value, a wrong digit or sign, missing part of the answer, or a unit conversion that does not match.",
        },
    },
}

ALGEBRA_QUESTIONS = {
    "same": {
        "type": "noul",
        "instructions": "The user_answer is mathematically equivalent to the correct_answer: they are equal for every value of the variables where both are defined, even if written in a different form.",
        "criteria": {
            "true": "Same expression or solution set in another form: expanded, factored, reordered, rationalised, a different but equal identity, or the same roots or interval written differently.",
            "false": "A different expression or set: a wrong sign, coefficient, exponent or constant, a missing or extra root, or a wrong interval endpoint.",
        },
    },
}

ROUTE_QUESTIONS = {
    "compute": {
        "type": "noul",
        "instructions": "Grading an answer to this question correctly requires checking a numeric calculation or a step-by-step algebraic, symbolic or logical derivation.",
        "criteria": {
            "true": "A marker must verify arithmetic, a computed value, a worked derivation or a proof to know whether the answer is right.",
            "false": "A marker only needs to check that the answer states the right facts, definitions or explanations; no calculation or derivation has to be verified.",
        },
    },
    "kind": {
        "type": "choice",
        "instructions": "What kind of checking does grading this question need?",
        "criteria": {
            "recall_or_explanation": "Recall a fact, definition or name, or explain a concept in words; no calculation to verify.",
            "numeric_calculation": "Compute a number from given values (arithmetic, formula, conversion, counting).",
            "symbolic_derivation": "Manipulate expressions, prove or derive a result step by step.",
        },
    },
}


def rubric_question(rubric: str) -> dict:
    return {
        "type": "noul",
        "instructions": f"The user_answer conveys this marking point: {rubric}",
        "criteria": {
            "true": "The answer states this point or clearly conveys it in its own words.",
            "false": "The answer omits the point, states the opposite, or only uses related vocabulary without making the point.",
        },
    }


def call(key: str, state: dict, questions: dict = QUESTIONS) -> dict:
    body = json.dumps({"model": "jev-latest", "state": state, "questions": questions}).encode()
    req = urllib.request.Request(
        URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.load(r)
    out["latency_s"] = round(time.time() - t, 2)
    return out


def run_pairs(key: str, fixture: Path, out: Path, group_keys: tuple[str, ...], questions: dict = EQUIV_QUESTIONS) -> int:
    pairs = json.loads(fixture.read_text(encoding="utf-8"))["pairs"]

    def run(p):
        res = call(key, {"question": p["question"], "correct_answer": p["correct"], "user_answer": p["user"]}, questions)
        return {**p, "same": res["answers"]["same"]["noul"], "input_tokens": res["usage"]["input_tokens"], "latency_s": res["latency_s"]}

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(run, pairs))
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    label = lambda r: " ".join(str(r[k]) for k in group_keys)
    print(f"{'group':20} {'exp':4} {'same':>5}  {'correct':18} {'user':20}  question")
    for r in rows:
        miss = (r["expected"] == "eq") != (r["same"] >= 0.5)
        flag = ("  <- MISS" if miss else "") + ("  (arguable)" if r.get("arguable") else "")
        print(f"{label(r):20} {r['expected']:4} {r['same']:5.2f}  {r['correct']:18} {r['user']:20}  {r['question'][:40]}{flag}")
    print()

    def summary(name, sub):
        strict = [r for r in sub if not r.get("arguable")]
        eq = [r for r in strict if r["expected"] == "eq"]
        neq = [r for r in strict if r["expected"] == "neq"]
        print(f"{name:20} eq marked different {sum(r['same'] < 0.5 for r in eq):2}/{len(eq):<3} neq marked same {sum(r['same'] >= 0.5 for r in neq):2}/{len(neq):<3} (arguable excluded: {len(sub) - len(strict)})")

    for k in group_keys:
        for v in dict.fromkeys(r[k] for r in rows):
            summary(f"{k}={v}", [r for r in rows if r[k] == v])
    summary("all", rows)
    print(f"raw: {out}")
    return 0


def run_rubric(key: str) -> int:
    """One noul per rubric, no model answer. Essays from the fixture plus the 8 English seed files."""
    jobs = []
    for c in json.loads(RUBRIC_FIXTURE.read_text(encoding="utf-8"))["cases"]:
        for a in c["answers"]:
            jobs.append({"set": "essay", "domain": c["domain"], "question": c["question"], "rubrics": c["rubrics"], "label": a["label"], "text": a["text"], "met": a["met"]})
    skip = set(json.loads(EXCEPTIONS.read_text(encoding="utf-8"))["cases"])
    for path in sorted(SEEDS.glob("*.en.json")):
        domain = path.name[: -len(".en.json")]
        for i, (q, pa, pb, para, wrong) in enumerate(json.loads(path.read_text(encoding="utf-8")), 1):
            for label, text, met in (("paraphrase", para, [1, 1]), ("partial_a", pa, [1, 0]), ("partial_b", pb, [0, 1]), ("misconception", wrong, [0, 0])):
                if f"{domain}/{i}/{label}" in skip:
                    continue
                jobs.append({"set": "seed", "domain": domain, "question": q, "rubrics": [pa, pb], "label": label, "text": text, "met": met})

    def run(j):
        qs = {f"r{i}": rubric_question(r) for i, r in enumerate(j["rubrics"])}
        res = call(key, {"question": j["question"], "user_answer": j["text"]}, qs)
        return {**j, "noul": [res["answers"][f"r{i}"]["noul"] for i in range(len(j["rubrics"]))], "input_tokens": res["usage"]["input_tokens"]}

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(run, jobs))
    RUBRIC_OUT.parent.mkdir(parents=True, exist_ok=True)
    RUBRIC_OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    def award(flags):  # app mapping: all rubrics -> 1, some -> 0.5, none -> 0
        k = sum(flags)
        return 1 if k == len(flags) else 0.5 if k else 0

    for r in rows:
        r["pred"] = [int(v >= 0.5) for v in r["noul"]]
        r["award_exp"], r["award_pred"] = award(r["met"]), award(r["pred"])

    def summary(name, sub):
        met = [(m, p) for r in sub for m, p in zip(r["met"], r["pred"])]
        fn = sum(1 for m, p in met if m and not p)
        fp = sum(1 for m, p in met if not m and p)
        n_met, n_unmet = sum(1 for m, _ in met if m), sum(1 for m, _ in met if not m)
        exact = sum(r["award_exp"] == r["award_pred"] for r in sub)
        over = sum(r["award_pred"] > r["award_exp"] for r in sub)
        under = sum(r["award_pred"] < r["award_exp"] for r in sub)
        print(f"{name:24} rubric met→missed {fn:3}/{n_met:<4} unmet→credited {fp:3}/{n_unmet:<4} | award exact {exact:3}/{len(sub):<4} over {over:3} under {under:3}")

    for set_name in ("essay", "seed"):
        sub = [r for r in rows if r["set"] == set_name]
        print(f"== {set_name} ({len(sub)} answers)")
        for d in dict.fromkeys(r["domain"] for r in sub):
            summary(d, [r for r in sub if r["domain"] == d])
        print("-- by answer kind")
        for lab in dict.fromkeys(r["label"].split("_")[0] if r["label"].startswith("partial") else r["label"] for r in sub):
            summary(lab, [r for r in sub if (r["label"].split("_")[0] if r["label"].startswith("partial") else r["label"]) == lab])
        summary("all", sub)
        print()
    print("-- essay misses (rubric truth != prediction)")
    for r in rows:
        if r["set"] == "essay":
            for i, (m, p, v) in enumerate(zip(r["met"], r["pred"], r["noul"])):
                if m != p:
                    print(f"{r['domain']:12} {r['label']:22} r{i} truth={m} noul={v:.2f}  {r['rubrics'][i][:80]}")
    print(f"requests {len(rows)}  input tokens {sum(r['input_tokens'] for r in rows)}")
    print(f"raw: {RUBRIC_OUT}")
    return 0


def run_route(key: str) -> int:
    """Can jev tell which questions need calculation checking, from the question alone or with the model answer?"""
    qs = json.loads(ROUTE_FIXTURE.read_text(encoding="utf-8"))["questions"]
    conds = ("q_only", "q_answer", "q_answer_rubrics")
    jobs = [(q, c) for q in qs for c in conds]

    def run(job):
        q, c = job
        state = {"question": q["question"]}
        if c != "q_only":
            state["correct_answer"] = q["answer"]
        if c == "q_answer_rubrics":
            state["rubrics"] = q["rubrics"]
        res = call(key, state, ROUTE_QUESTIONS)
        a = res["answers"]
        return {**q, "cond": c, "compute_noul": a["compute"]["noul"], "kind_choice": a["kind"]["choice"], "kind_conf": a["kind"]["confidence"], "kind_probs": a["kind"]["probabilities"]}

    with ThreadPoolExecutor(max_workers=8) as pool:
        rows = list(pool.map(run, jobs))
    ROUTE_OUT.parent.mkdir(parents=True, exist_ok=True)
    ROUTE_OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    def summary(name, sub):
        strict = [r for r in sub if not r.get("arguable")]
        comp = [r for r in strict if r["compute"]]
        non = [r for r in strict if not r["compute"]]
        miss_c = sum(r["compute_noul"] < 0.5 for r in comp)
        miss_n = sum(r["compute_noul"] >= 0.5 for r in non)
        choice_ok = sum((r["kind_choice"] != "recall_or_explanation") == r["compute"] for r in strict)
        print(f"{name:34} compute→routed to jev {miss_c:2}/{len(comp):<3} non-compute→routed to LLM {miss_n:2}/{len(non):<3} noul acc {100 * (len(strict) - miss_c - miss_n) / len(strict):5.1f}%  choice acc {100 * choice_ok / len(strict):5.1f}%")

    for c in conds:
        sub = [r for r in rows if r["cond"] == c]
        print(f"== {c}")
        summary("all", sub)
        summary("deceptive only", [r for r in sub if r.get("deceptive")])
        summary("plain only", [r for r in sub if not r.get("deceptive")])
        for k in ("recall", "explain", "numeric", "symbolic"):
            summary(f"kind={k}", [r for r in sub if r["kind"] == k])
        print()
    print("-- misses (noul side wrong), per condition")
    for c in conds:
        for r in rows:
            if r["cond"] == c and not r.get("arguable") and (r["compute_noul"] >= 0.5) != r["compute"]:
                print(f"{c:17} {r['kind']:9} {'DECEPTIVE' if r.get('deceptive') else '':9} noul={r['compute_noul']:.2f} choice={r['kind_choice']:22} {r['question'][:70]}")
    print(f"raw: {ROUTE_OUT}")
    return 0


def main() -> int:
    key = os.environ.get("TYPESAFE_API_KEY")
    if not key:
        print("TYPESAFE_API_KEY is required", file=sys.stderr)
        return 2
    if sys.argv[1:] == ["equiv"]:
        return run_pairs(key, EQUIV_FIXTURE, EQUIV_OUT, ("group",))
    if sys.argv[1:] == ["units"]:
        return run_pairs(key, UNITS_FIXTURE, UNITS_OUT, ("kind", "family"))
    if sys.argv[1:] == ["algebra"]:
        return run_pairs(key, ALGEBRA_FIXTURE, ALGEBRA_OUT, ("family",), ALGEBRA_QUESTIONS)
    if sys.argv[1:] == ["rubric"]:
        return run_rubric(key)
    if sys.argv[1:] == ["route"]:
        return run_route(key)
    cases = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]

    jobs = []
    for case in cases:
        for ans in case["answers"]:
            for cond in ("no_ref", "final_ref", "with_ref"):
                state = {"question": case["question"], "user_answer": ans["text"]}
                if cond == "with_ref":
                    state["correct_answer"] = case["reference"]
                elif cond == "final_ref":
                    state["correct_answer"] = case["final"]
                jobs.append((case, ans, cond, state))

    def run(job):
        case, ans, cond, state = job
        res = call(key, state)
        a = res["answers"]
        return {
            "case": case["id"], "level": case["level"], "label": ans["label"],
            "expected": ans["expected"], "step_only": ans.get("step_only", False),
            "cond": cond,
            "correct": a["correct"]["noul"], "has_error": a["has_error"]["noul"],
            "award": a["award"]["score"], "award_conf": a["award"]["confidence"],
            "input_tokens": res["usage"]["input_tokens"], "latency_s": res["latency_s"],
        }

    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = list(pool.map(run, jobs))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(json.dumps(r, ensure_ascii=False) for r in rows) + "\n", encoding="utf-8")

    # Per-answer table: noul "correct" and award score per condition (0 = no ref, F = final-only ref, R = worked ref).
    by = {(r["case"], r["label"], r["cond"]): r for r in rows}
    conds = ("no_ref", "final_ref", "with_ref")
    print(f"{'case':14} {'L':>1} {'label':28} {'exp':7} | {'cor0':>5} {'corF':>5} {'corR':>5} | {'awd0':>5} {'awdF':>5} {'awdR':>5}")
    for case in cases:
        for ans in case["answers"]:
            r = [by[(case["id"], ans["label"], c)] for c in conds]
            flag = ""
            if ans["expected"] == "wrong" and any(x["correct"] >= 0.5 for x in r):
                flag = "  <- FP " + "".join("x" if x["correct"] >= 0.5 else "." for x in r)
            if ans["expected"] == "correct" and any(x["correct"] < 0.5 for x in r):
                flag = "  <- FN " + "".join("x" if x["correct"] < 0.5 else "." for x in r)
            cor = " ".join(f"{x['correct']:5.2f}" for x in r)
            awd = " ".join(f"{x['award']:5.2f}" for x in r)
            print(f"{case['id']:14} {case['level']:>1} {ans['label']:28} {ans['expected']:7} | {cor} | {awd}{flag}")

    # Aggregate: threshold 0.5 on the "correct" noul.
    print()
    for cond in ("no_ref", "final_ref", "with_ref"):
        sub = [r for r in rows if r["cond"] == cond]
        wrong = [r for r in sub if r["expected"] == "wrong"]
        step = [r for r in wrong if r["step_only"]]
        final = [r for r in wrong if not r["step_only"]]
        right = [r for r in sub if r["expected"] == "correct"]
        fp = sum(r["correct"] >= 0.5 for r in wrong)
        fp_step = sum(r["correct"] >= 0.5 for r in step)
        fp_final = sum(r["correct"] >= 0.5 for r in final)
        fn = sum(r["correct"] < 0.5 for r in right)
        # Award mapped like the app: >= 1.5 -> 1, >= 0.5 -> 0.5, else 0.
        fp_award = sum(r["award"] >= 1.5 for r in wrong)
        fn_award = sum(r["award"] < 1.5 for r in right)
        print(f"{cond:9} noul: wrong marked correct {fp}/{len(wrong)} (final wrong {fp_final}/{len(final)}, step-only {fp_step}/{len(step)}), correct marked wrong {fn}/{len(right)} | award>=1.5: wrong full marks {fp_award}/{len(wrong)}, correct not full {fn_award}/{len(right)}")
    tok = sum(r["input_tokens"] for r in rows)
    lat = sorted(r["latency_s"] for r in rows)
    print(f"requests {len(rows)}  input tokens {tok}  latency p50 {lat[len(lat)//2]}s max {lat[-1]}s")
    print(f"raw: {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
