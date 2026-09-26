"""LLM judge: score each descriptor + summary against the current document.

The judge (DeepSeek V4 Pro 0813 on DeepInfra, a larger model than the
summarizer) sees the true outline of the round (headings from the round's
HTML with word counts, so it knows what exists and how large it is), the edit
history in plain words, and one summary at a time; the arm name is hidden.
It returns stale claims, missing major parts and four 1-5 scores.
Usage: python judge.py chapter|book
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import llm

HERE = Path(__file__).resolve().parent
WORK = HERE / "work"
JUDGE = "deepseek-ai/DeepSeek-V4-Pro-0813"
ARMS = ("diff2", "chunk2", "diff3", "diff3t", "diff", "chunk")

SYSTEM = """You evaluate a short descriptor and summary of a study document. Another assistant reads them to decide whether the document is relevant to a student's question before searching it. You get the document's current outline with the word count of each part, the history of edits that produced this version, and the descriptor and summary to evaluate.

Judge only against the current document. Content that an edit removed is no longer in the document. Content the outline does not show may still be inside a listed part; only call a claim stale when it describes something the edit history removed or that clearly cannot be in the listed parts.

Return ONLY JSON:
{"stale": ["claims about content no longer in the document"],
 "missing_major": ["large parts of the current document (by word count) the text does not represent"],
 "accuracy": 1-5, "coverage": 1-5, "balance": 1-5, "usefulness": 1-5,
 "note": "one sentence"}
accuracy: 5 = no claim contradicts the current document. coverage: 5 = every large part is represented. balance: 5 = emphasis roughly follows the word counts; lower it when a small part takes much of the text. usefulness: 5 = an assistant could reliably tell which questions this document can answer."""


def outline(round_name: str, doc: str) -> str:
    lines = (WORK / f"{round_name}.html").read_text(encoding="utf-8").split("\n")
    levels = "1234" if doc == "chapter" else "12"
    rows: list[list] = []
    appendix = 0
    in_appendix = False
    for line in lines:
        m = re.match(r".*?<h([1-4])[^>]*>(.*?)</h\1>", line)
        words = len(re.sub(r"<[^>]+>", " ", line).split())
        if m:
            title = re.sub(r"<[^>]+>", "", m.group(2)).strip()
            if re.match(r"^\d+\.\d+ \(a\)", title):
                in_appendix = True
            if in_appendix:
                appendix += words
                continue
            if m.group(1) in levels:
                rows.append([int(m.group(1)), title, 0])
                continue
        if in_appendix:
            appendix += words
        elif rows:
            rows[-1][2] += words
    out = ["  " * (lvl - 1) + f"{title} ({n:,} words)" for lvl, title, n in rows]
    if appendix:
        out.append(
            f"Appendix: answers to end-of-chapter exercises ({appendix:,} words)"
        )
    return "\n".join(out)


def history(doc: str, round_name: str) -> str:
    rounds = json.loads((HERE / "rounds.json").read_text(encoding="utf-8"))
    items = [
        r
        for r in rounds
        if r["doc"] == doc and 0 < int(r["round"][1:]) <= int(round_name[1:])
    ]
    return (
        "\n".join(f"- {r['change']}" for r in items)
        or "(no edits: this is the original)"
    )


def judge(doc: str, round_name: str, label: str, summary: dict) -> dict:
    user = (
        f"Current outline:\n{outline(round_name, doc)}\n\n"
        f"Edit history, oldest first:\n{history(doc, round_name)}\n\n"
        f"Descriptor:\n{summary['descriptor']}\n\nSummary:\n{summary['summary']}"
    )
    record = llm.chat(
        f"judge-{label}",
        [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        model=JUDGE,
        temperature=0.0,
        max_tokens=1500,
    )
    text = record["content"]
    try:
        verdict = json.loads(text[text.find("{") : text.rfind("}") + 1])
    except json.JSONDecodeError:
        verdict = {"error": text[:500]}
    verdict["cost"] = record["cost_usd"]
    return verdict


def main() -> None:
    doc = sys.argv[1]
    results = json.loads((HERE / f"results-{doc}.json").read_text(encoding="utf-8"))
    rounds = sorted(
        {k.split("-")[0] for k in results["full"]}, key=lambda r: int(r[1:])
    )
    out_path = HERE / f"judged-{doc}.json"
    judged = (
        json.loads(out_path.read_text(encoding="utf-8")) if out_path.exists() else {}
    )
    for r in rounds:
        arms = {
            f"full-{s}": results["full"][f"{r}-{s}"]
            for s in "abc"
            if f"{r}-{s}" in results["full"]
        }
        if r != rounds[0]:
            arms["reuse"] = results["full"][f"{rounds[0]}-a"]
            for arm in ARMS:
                if arm in results and r in results[arm]:
                    arms[arm] = results[arm][r]
        for arm, summary in arms.items():
            key = f"{r}/{arm}"
            if key in judged:
                continue
            judged[key] = judge(doc, r, f"{doc}-{r}-{arm}", summary)
            out_path.write_text(
                json.dumps(judged, indent=1, ensure_ascii=False), encoding="utf-8"
            )
            v = judged[key]
            print(
                key,
                {
                    k: v.get(k)
                    for k in ("accuracy", "coverage", "balance", "usefulness")
                },
                len(v.get("stale") or []),
                round(llm.spent(), 4),
                flush=True,
            )


if __name__ == "__main__":
    main()
