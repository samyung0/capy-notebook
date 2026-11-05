"""Questions that cross pages, at each window size: the Biology gold's runs
(``.results/2023-bio-p4-v41-1017-<n>-w<size>.json``) against the paper's own
text layer. Every question there starts at the top of a page, so a question's
text is the text of its pages.

    python -I bench/extraction/scripts/window_crossing.py <references>/born-digital

Prints, per size and run: questions and parts saved, part marks right, the
share of each page's words that reached the question (figure labels stay in
the crop and count as missing at every size, so compare across sizes), and how
often continue_question was used and refused.
"""

from __future__ import annotations

import collections
import glob
import json
import re
import sys
from pathlib import Path

import pymupdf

HERE = Path(__file__).resolve().parents[1]
GOLD = json.loads((HERE / "fixtures" / "gold" / "2023-bio-p4.json").read_text())
FURNITURE = re.compile(r"©|UCLES|Turn over|\[Total|^\W*$|^\d{1,2}$|^\.{5,}")


def words(text: str) -> collections.Counter:
    plain = re.sub(r"\\[a-zA-Z]+|[{}$^_\\]", " ", text.lower())
    return collections.Counter(w for w in re.findall(r"[a-z]{3,}", plain))


def page_words(doc: pymupdf.Document, pages: list[int]) -> collections.Counter:
    out: collections.Counter = collections.Counter()
    for n in pages:
        for line in doc[n - 1].get_text().splitlines():
            if not FURNITURE.search(line.strip()):
                out += words(line)
    return out


def saved_text(question: dict) -> str:
    out = []
    for blocks in [question["stem"], *(p["blocks"] for p in question["parts"])]:
        for b in blocks:
            if b["type"] == "text":
                out.append(b["text"])
            elif b["type"] == "table":
                out.extend(c for row in b.get("rows") or [] for c in row)
    for part in question["parts"]:
        if part["answer"]["type"] == "mcq":
            out.extend(part["answer"]["options"])
    return "\n".join(out)


def main() -> None:
    doc = pymupdf.open(Path(sys.argv[1]) / GOLD["pdf"])
    gold = {q["label"]: q for q in GOLD["questions"]}
    print(
        "| Window | Run | Questions | Extra labels | Parts saved | Questions with the right parts and marks "
        "| Words kept (lowest question) | Q2(b) lead-in kept | Calls | Cut off | Refused | Continued | Not the open question | Seconds | Billed |"
    )
    print("|" + "---|" * 15)
    order = {"1": 1, "2": 2, "3": 3, "4": 4, "6": 6, "all": 99}
    files = glob.glob(str(HERE / ".results" / "2023-bio-p4*-v41-1017-*-w*.json"))
    # "from the cover": the same paper with every window's edges one page later.
    for path in sorted(
        files, key=lambda f: ("cover" in f, order[f.rsplit("-w", 1)[1][:-5]], f)
    ):
        r = json.loads(Path(path).read_text())
        size, run = path.rsplit("-w", 1)[1][:-5], path.split("-")[-2]
        if "cover" in path:
            size += " from the cover"
        w = r["scores"]["window"]
        labels = r["report"]["recorded"]
        saved = dict(zip(labels, r["questions"]))
        lead_in = "monitored" in saved_text(saved["2"]) if "2" in saved else False
        parts = right = 0
        kept_all, total_all, lowest = 0, 0, 1.0
        for label, g in gold.items():
            q = saved.get(label)
            if q is None:
                lowest = 0.0
                total_all += sum(page_words(doc, g["pages"]).values())
                continue
            parts += len(q["parts"])
            right += [p["marks"] for p in q["parts"]] == [
                p["marks"] for p in g["parts"]
            ]
            want = page_words(doc, g["pages"])
            kept = sum((want & words(saved_text(q))).values())
            kept_all += kept
            total_all += sum(want.values())
            lowest = min(lowest, kept / sum(want.values()))
        res = w["results"]
        print(
            f"| {size} | {run} | {sum(1 for l in gold if l in saved)}/6 | {len([l for l in labels if l not in gold])} "
            f"| {parts}/{sum(len(g['parts']) for g in gold.values())} | {right}/6 | {kept_all / total_all:.0%} ({lowest:.0%}) "
            f"| {'yes' if lead_in else 'no'} | {w['calls']} | {w['cut_off']} | {res.get('refused', 0)} | {res.get('continued', 0)} "
            f"| {res.get('not_open', 0)} | {r['seconds']:.0f} | ${r['billed_usd']} |"
        )


if __name__ == "__main__":
    main()
