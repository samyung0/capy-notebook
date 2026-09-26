"""Deterministic edit checks: does each summary name added topics and drop
removed ones? Case-insensitive substring tests on descriptor and summary."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# round -> (kind, label, patterns). "added" must appear, "removed" must not.
CHECKS = {
    "chapter": {
        "c1": [("added", "KDE / violin", r"kernel density|violin")],
        "c2": [
            ("added", "sleep study", r"sleep"),
            ("removed", "malaria study", r"malaria|pfspz"),
        ],
        "c3": [("removed", "mosaic / pie", r"mosaic|pie chart")],
        "c5": [("added", "Cramer's V", r"cram[eé]r")],
    },
    "book": {
        "b1": [("added", "bootstrap", r"bootstrap")],
        "b2": [
            ("added", "home prices", r"home|house|housing"),
            ("removed", "Mario Kart", r"mario"),
        ],
        "b3": [("removed", "negative binomial", r"negative binomial")],
        "b5": [("added", "transformations", r"transformation|elasticit|nonlinear")],
        "b6": [
            (
                "removed",
                "chapter 3 probability",
                r"conditional probabilit|bayes|tree diagram|addition rule|disjoint",
            )
        ],
    },
}


def checks_until(doc: str, round_name: str) -> list[tuple[str, str, str, str]]:
    """Every check introduced at or before this round (edits accumulate)."""
    order = sorted(CHECKS[doc])
    out = []
    for r in order:
        if int(r[1:]) <= int(round_name[1:]):
            out.extend((r, *c) for c in CHECKS[doc][r])
    return out


def score(doc: str, round_name: str, text: str) -> dict[str, bool]:
    text = text.lower()
    result = {}
    for r, kind, label, pattern in checks_until(doc, round_name):
        hit = re.search(pattern, text) is not None
        result[f"{r} {kind} {label}"] = hit if kind == "added" else not hit
    return result


if __name__ == "__main__":
    doc = sys.argv[1]
    results = json.loads((HERE / f"results-{doc}.json").read_text(encoding="utf-8"))
    rounds = sorted(
        {k.split("-")[0] for k in results["full"]}, key=lambda r: int(r[1:])
    )
    for r in rounds:
        print(f"=== {r}")
        arms = {
            "full-a": results["full"].get(f"{r}-a"),
            "full-b": results["full"].get(f"{r}-b"),
        }
        for mode in ("diff", "chunk", "diff2", "chunk2", "diff3", "diff3t"):
            if mode in results:
                arms[mode] = results[mode].get(r)
        arms["reuse"] = results["full"][f"{rounds[0]}-a"]
        for arm, s in arms.items():
            if not s:
                continue
            text = s["descriptor"] + " " + s["summary"]
            d = score(doc, r, s["descriptor"])
            f = score(doc, r, text)
            ok_d = sum(d.values())
            ok_f = sum(f.values())
            print(
                f"  {arm:7s} words {len(s['summary'].split()):3d} "
                f"descriptor {ok_d}/{len(d)} full {ok_f}/{len(f)} "
                + " ".join(
                    k.split(" ", 1)[1] + ("" if v else " FAIL")
                    for k, v in f.items()
                    if not v
                )
            )
