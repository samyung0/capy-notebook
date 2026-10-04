"""Alternative methods: a deterministic checker against Jev on answers that leave the scheme's route.

Standard library only. Three questions from fixtures/alt-methods.json, where a correct
answer may take a different route from the marking scheme, skip a step, or reach the
right value with wrong working:

  triangle_area    numeric. Every line is checked against a table of the triangle's
                   true quantities (sides, semi-perimeter, heights, angles, area).
  circle_angle     angle proof. Claims are checked against a coordinate figure, and
                   each cited theorem's preconditions are checked on that figure.
  linear_equation  algebra. Every line must keep the original solution, x = 11.

The checker reads the structured 'lines' / 'claims' a MathLive input would produce;
turning free text into that structure is not tested here. Jev reads 'text' through the
production request (one choice per item plus the vocabulary guard) in three arms:
steps (unchanged), policy (an any-valid-method rule in the state) and policy_ref
(rule plus the scheme's worked solution). A fourth Jev request asks which theorem
each circle reason names, the recognition step a structured checker needs.

    python bench/grading/scripts/alt_methods.py --check
    TYPESAFE_API_KEY=... python bench/grading/scripts/alt_methods.py --output DIR
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import jev_context
from jev_contract import GRADES, GUARD_ID, GUARD_THRESHOLD, production_questions

ROOT = Path(__file__).resolve().parents[3]
FIXTURE = ROOT / "bench/grading/fixtures/alt-methods.json"
ARMS = ("steps", "policy", "policy_ref")
RULES = (
    "Award a marking item when the answer achieves what the item rewards by any correct "
    "method, even if the method differs from the one the item names, unless the question "
    "requires a particular method. A value is credited when it is stated or clearly "
    "implied by later correct working. A final answer that does not follow from the "
    "student's own working earns no credit. A reason earns credit only if it correctly "
    "justifies its step."
)
THEOREMS = {
    "same_segment": "Angles in the same segment are equal (angles subtended by the same arc or chord).",
    "semicircle": "The angle in a semicircle is a right angle.",
    "centre": "The angle at the centre is twice the angle at the circumference.",
    "triangle_sum": "Angles in a triangle add up to 180°.",
    "cyclic_opposite": "Opposite angles of a cyclic quadrilateral add up to 180°.",
    "alternate_segment": "Alternate segment theorem (angle between a tangent and a chord).",
    "other": "Any other reason, or no recognisable theorem.",
}


# --- deterministic checker ---------------------------------------------------------

NUMERIC = {
    "sin": lambda d: math.sin(math.radians(d)),
    "cos": lambda d: math.cos(math.radians(d)),
    "tan": lambda d: math.tan(math.radians(d)),
    "sqrt": math.sqrt,
}


def evaluate(expr, names=None):
    return eval(expr, {"__builtins__": {}}, {**NUMERIC, **(names or {})})


def close(a, b, rel=0.01):
    return abs(a - b) <= rel * max(abs(a), abs(b), 1e-9)


def triangle_truth():
    a, b, angle = 7, 5, 40
    area = 0.5 * a * b * NUMERIC["sin"](angle)
    c = math.sqrt(a * a + b * b - 2 * a * b * NUMERIC["cos"](angle))
    s = (a + b + c) / 2
    q = math.degrees(math.asin(b * NUMERIC["sin"](angle) / c))
    derived = {
        "QR": c,
        "QR²": c * c,
        "s": s,
        "s − PQ": s - a,
        "s − PR": s - b,
        "s − QR": s - c,
        "height to PQ": 2 * area / a,
        "height to PR": 2 * area / b,
        "height to QR": 2 * area / c,
        "angle Q": q,
        "angle R": 180 - angle - q,
        "area": area,
    }
    return area, derived


def check_triangle(answer, question):
    area, derived = triangle_truth()
    notes, method, first_bad = [], False, None
    for i, line in enumerate(answer["lines"]):
        parts = [p.strip() for p in line.split("=")]
        values = []
        for part in parts[1:]:
            values.append(evaluate(part))
        stated = values[-1]
        consistent = all(close(v, stated) for v in values)
        match = next((k for k, v in derived.items() if close(v, stated)), None)
        if not consistent:
            notes.append(f"line {i + 1}: {parts[1]} is {values[0]:.4g}, not {stated:g}")
        elif match is None:
            notes.append(f"line {i + 1}: {stated:g} is not a quantity of this triangle")
        else:
            notes.append(f"line {i + 1}: {stated:g} = true {match}")
        if (not consistent or match is None) and first_bad is None:
            first_bad = i
        if consistent and match and first_bad is None:
            method = True
    valid = first_bad is None
    final_ok = close(answer["final"], area, 0.005)
    answer_mark = final_ok and valid
    if not answer["lines"]:
        method = final_ok  # no working asked for: the method mark is implied
        notes.append("no working; final answer checked alone")
    return [int(method), int(answer_mark)], notes


def circle_figure():
    """Unit circle, AC a diameter, BAC = 32°, A-B-C-D in order around the circle."""
    at = lambda deg: (math.cos(math.radians(deg)), math.sin(math.radians(deg)))
    return {"O": (0.0, 0.0), "A": at(180), "B": at(64), "C": at(0), "D": at(250)}


def angle(fig, name):
    p, v, q = (fig[ch] for ch in name)
    a1 = math.atan2(p[1] - v[1], p[0] - v[0])
    a2 = math.atan2(q[1] - v[1], q[0] - v[0])
    d = abs(math.degrees(a1 - a2)) % 360
    return min(d, 360 - d)


def side(fig, p, q, r):
    (x1, y1), (x2, y2), (x3, y3) = fig[p], fig[q], fig[r]
    return math.copysign(1, (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1))


def theorem_holds(fig, reason, lhs, refs):
    """Does the cited theorem license this claim in this figure?"""
    on_circle = lambda pt: pt != "O"
    chord = lambda name: frozenset((name[0], name[2]))
    if reason == "same_segment":
        if len(refs) != 1:
            return False
        other = refs[0]
        p, q = sorted(chord(lhs))
        return (
            chord(lhs) == chord(other)
            and on_circle(lhs[1])
            and on_circle(other[1])
            and side(fig, p, q, lhs[1]) == side(fig, p, q, other[1])
        )
    if reason == "semicircle":
        p, q = chord(lhs)
        mid = ((fig[p][0] + fig[q][0]) / 2, (fig[p][1] + fig[q][1]) / 2)
        return on_circle(lhs[1]) and math.dist(mid, fig["O"]) < 1e-9 and not refs
    if reason == "centre":
        if len(refs) != 1:
            return False
        central, inscribed = (lhs, refs[0]) if lhs[1] == "O" else (refs[0], lhs)
        p, q = sorted(chord(central))
        return (
            central[1] == "O"
            and on_circle(inscribed[1])
            and chord(central) == chord(inscribed)
            and side(fig, p, q, inscribed[1]) == side(fig, p, q, "O")
        )
    if reason == "triangle_sum":
        return len(refs) == 2 and all(set(r) == set(lhs) for r in refs) and len(
            {lhs[1], refs[0][1], refs[1][1]}
        ) == 3
    if reason == "angle_split":
        if len(refs) != 2 or any(r[1] != lhs[1] for r in refs):
            return False
        whole, part = refs
        return math.isclose(angle(fig, part) + angle(fig, lhs), angle(fig, whole))
    # cyclic_opposite gives a sum of 180, alternate_segment needs a tangent: neither
    # licenses any claim this figure's questions make.
    return False


def check_circle(answer, question):
    fig = circle_figure()
    known = {"BAC"}
    notes, all_valid, final = [], True, answer.get("final")
    for i, c in enumerate(answer["claims"]):
        lhs, expr = (s.strip() for s in c["claim"].split("="))
        refs = re.findall(r"[A-DO]{3}", expr)
        true_value = angle(fig, lhs)
        relation = math.isclose(
            evaluate(expr, {r: angle(fig, r) for r in refs}), true_value, abs_tol=0.01
        )
        stated = math.isclose(c["value"], true_value, abs_tol=0.5)
        licensed = theorem_holds(fig, c["reason"], lhs, refs)
        grounded = all(r in known for r in refs)
        ok = relation and stated and licensed and grounded
        problems = [
            msg
            for flag, msg in (
                (stated, f"{lhs} is {true_value:.0f}°, not {c['value']}°"),
                (relation, f"{c['claim']} is false in the figure"),
                (licensed, f"'{c['reason']}' does not justify {c['claim']}"),
                (grounded, f"uses an angle not yet established ({', '.join(refs)})"),
            )
            if not flag
        ]
        notes.append(f"step {i + 1} {c['claim']}: " + ("ok" if ok else "; ".join(problems)))
        all_valid &= ok
        if stated:
            known.add(lhs)
        if lhs == "BDC":
            final = c["value"]
    answer_mark = final is not None and math.isclose(final, angle(fig, "BDC"), abs_tol=0.5)
    reaches = any(c["claim"].startswith("BDC") for c in answer["claims"])
    reason_mark = all_valid and reaches
    if not answer["claims"]:
        notes.append("no reasons given")
    return [int(answer_mark), int(reason_mark)], notes


def linear_root(expr_l, expr_r, var):
    f = lambda v: evaluate(expr_l, {var: v}) - evaluate(expr_r, {var: v})
    f0, f1 = f(0), f(1)
    if math.isclose(f0, f1):
        return None  # identity or contradiction
    return -f0 / (f1 - f0)


def check_linear(answer, question):
    target = linear_root("3*(x - 2)", "2*x + 5", "x")
    subs, notes, roots = {}, [], []
    for i, line in enumerate(answer["lines"]):
        if line.startswith("let "):
            var, expr = (s.strip() for s in line[4:].split("="))
            subs[var] = expr
            notes.append(f"line {i + 1}: substitution {var} = {expr}")
            roots.append(target)
            continue
        left, right = (s.strip() for s in line.split("="))
        var = next(v for v in ("x", *subs) if re.search(rf"\b{v}\b", line))
        root = linear_root(left, right, var)
        if var != "x" and root is not None:
            root = linear_root(subs[var], str(root), "x")
        roots.append(root)
        prev = roots[-2] if len(roots) > 1 else target
        ok = root is not None and math.isclose(root, target)
        follows = root is not None and prev is not None and math.isclose(root, prev)
        notes.append(
            f"line {i + 1}: "
            + ("keeps x = 11" if ok else f"gives x = {root:g}" if root is not None else "no single solution")
            + ("" if ok or not follows else " (follows from the line before)")
        )
    valid = [r is not None and math.isclose(r, target) for r in roots]
    first_bad = valid.index(False) if False in valid else len(valid)
    working = answer["lines"][:first_bad]
    has_working = len(answer["lines"]) > 1
    expand = any("(" not in l and "let" not in l for l in working[:-1] or working) and has_working
    collect = has_working and any(
        len([s for s in l.split("=") if re.search(r"[a-z]", s)]) == 1 for l in working if not l.startswith("let")
    )
    last = answer["lines"][-1].replace(" ", "") if answer["lines"] else ""
    answer_mark = first_bad == len(valid) and last == "x=11"
    if question.get("requires_working") and not has_working:
        notes.append("working required and none shown: method marks withheld")
    if first_bad == len(valid) and has_working:
        expand = collect = True  # a valid chain to x = 11 implies the skipped steps
    return [int(expand), int(collect), int(answer_mark)], notes


CHECKERS = {
    "triangle_area": check_triangle,
    "circle_angle": check_circle,
    "linear_equation": check_linear,
}


# --- Jev ------------------------------------------------------------------------------


def jobs(fixture):
    out = []
    for q in fixture["questions"]:
        for a in q["answers"]:
            for arm in ARMS:
                state = {"question": q["question"], "markscheme": q["markscheme"]}
                if arm != "steps":
                    state["marking_rules"] = RULES
                if arm == "policy_ref":
                    state["reference_solution"] = q["reference"]
                state["user_answer"] = a["text"]
                out.append(
                    {
                        "id": f"{q['id']}/{a['kind']}#{arm}",
                        "arm": arm,
                        "state": state,
                        "questions": production_questions(q["markscheme"]),
                        "keys": [GUARD_ID],
                    }
                )
            reasons = re.findall(r"\(([^)]*)\)", a["text"])
            if q["id"] == "circle_angle" and reasons:
                out.append(
                    {
                        "id": f"{q['id']}/{a['kind']}#recognise",
                        "arm": "recognise",
                        "state": {"reasons": reasons},
                        "questions": {
                            f"r{i}": {
                                "type": "choice",
                                "instructions": f"Which theorem does `reasons[{i}]` state? Judge only what it says, not whether it is true.",
                                "criteria": THEOREMS,
                            }
                            for i in range(len(reasons))
                        },
                        "keys": [],
                    }
                )
    return out


def decode(row):
    if "error" in row:
        return row
    answers = row["response"]["answers"]
    if row["arm"] == "recognise":
        row["named"] = [answers[f"r{i}"]["choice"] for i in range(len(row["questions"]))]
        return row
    guard = answers[GUARD_ID]["noul"]
    n = len(row["questions"]) - 1
    choices = [answers[f"m{i}_choice"] for i in range(n)]
    row["guard"] = guard
    row["awards"] = [0 if guard >= GUARD_THRESHOLD else GRADES[c["choice"]] for c in choices]
    row["confidence"] = [c["confidence"] for c in choices]
    return row


# --- report ---------------------------------------------------------------------------


def report(fixture, rows):
    by = {r["id"]: r for r in rows}
    totals = {name: [0, 0] for name in ("checker", *ARMS)}
    for q in fixture["questions"]:
        print(f"\n## {q['id']}   scheme: {' | '.join(q['markscheme'])}")
        print(f"{'answer':24} {'gold':10} {'checker':10} " + " ".join(f"{a:10}" for a in ARMS))
        for a in q["answers"]:
            marks, notes = CHECKERS[q["id"]](a, q)
            cells = {"checker": marks}
            for arm in ARMS:
                r = by.get(f"{q['id']}/{a['kind']}#{arm}", {})
                cells[arm] = r.get("awards", "ERR")
            fmt = lambda m: "ERR" if m == "ERR" else "/".join(f"{v:g}" for v in m)
            line = f"{a['kind'] + ('*' if a.get('arguable') else ''):24} {fmt(a['gold']):10} "
            line += " ".join(f"{fmt(cells[k]):10}" for k in ("checker", *ARMS))
            print(line)
            for n in notes:
                print(f"{'':26}checker: {n}")
            rec = by.get(f"{q['id']}/{a['kind']}#recognise")
            if rec and "named" in rec:
                cited = [c["reason"] for c in a["claims"] if c["reason"] != "angle_split"]
                print(f"{'':26}jev reads reasons as {rec['named']} (cited {cited})")
            if not a.get("arguable"):
                for k, m in cells.items():
                    if m != "ERR":
                        totals[k][0] += sum(x == g for x, g in zip(m, a["gold"]))
                        totals[k][1] += len(a["gold"])
    print("\nItems exact, arguable answers excluded:")
    for k, (ok, n) in totals.items():
        print(f"  {k:10} {ok}/{n}")
    recs = [r for r in rows if r.get("arm") == "recognise" and "named" in r]
    if recs:
        gold = {
            f"circle_angle/{a['kind']}#recognise": [
                c["reason"] if c["reason"] in THEOREMS else "other"
                for c in a["claims"]
                if c["reason"] != "angle_split"
            ]
            for q in fixture["questions"]
            if q["id"] == "circle_angle"
            for a in q["answers"]
        }
        hits = sum(x == g for r in recs for x, g in zip(r["named"], gold[r["id"]]))
        print(f"  theorem recognition {hits}/{sum(len(gold[r['id']]) for r in recs)}")


def check(fixture):
    for q in fixture["questions"]:
        for a in q["answers"]:
            marks, _ = CHECKERS[q["id"]](a, q)
            assert len(marks) == len(a["gold"]) == len(q["markscheme"]), a["kind"]
    js = jobs(fixture)
    assert all("gold" not in json.dumps(j) and "note" not in j["state"] for j in js)
    print(f"Offline check passed: {len(js)} Jev requests planned, checker runs on every answer.")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--checker-only", action="store_true")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if args.check:
        check(fixture)
        return 0
    if args.checker_only:
        report(fixture, [])
        return 0
    if args.output is None or args.output.exists():
        parser.error("--output must name a fresh directory")
    key = os.environ.get("TYPESAFE_API_KEY", "").strip()
    if not key:
        parser.error("TYPESAFE_API_KEY is required")
    args.output.mkdir(parents=True)
    planned = jobs(fixture)
    with ThreadPoolExecutor(max_workers=4) as pool:
        rows = [decode(r) for r in pool.map(lambda j: jev_context.call(j, key), planned)]
    (args.output / "results.jsonl").write_text(
        "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8"
    )
    report(fixture, rows)
    failures = sum("error" in r for r in rows)
    clean = all(key[:8] not in p.read_text(encoding="utf-8") for p in args.output.iterdir())
    print(f"\n{len(rows)} requests, {failures} failed; credential marker absent: {clean}")
    return int(failures > 0 or not clean)


if __name__ == "__main__":
    sys.exit(main())
