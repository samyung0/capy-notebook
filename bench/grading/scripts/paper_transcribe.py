"""One call reads a whole uploaded paper: each part's pages, a box around its
answer, and for short answers the text written, scored against where the
fixture really drew it.

    uv run --with httpx --with pillow python -I paper_transcribe.py <repo> <env file> <pages dir> <out.jsonl> [runs]

The pages are paper_fixture.py's, already rendered in <pages dir> at 1,024 and
1,568 px. Boxes are in 0-1000 of the page's width and height. A box is scored
by how much of the true answer it covers (a crop must not cut working off) and
by IoU (how tight it is), as returned and with a margin added on every side
(PAD, thousandths of the page), since a crop shown to a marker can afford slack.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).parent))
from paper_fixture import PAGES, PARTS  # noqa: E402
from paper_marking import OUT, RUNS, call, pages_content, total  # noqa: E402

TRANSCRIBE = """You see every page of one student's handwritten answer paper, in order, and the list of question parts. For each part:
- "pages": the page numbers where the student writes its answer, in order. Answers may run over several pages or come out of order. A part the student did not answer gets [].
- "boxes": one box per page the answer is on, {"page": n, "box": [left, top, right, bottom]}, in thousandths of the page's width and height, around the whole answer to that part on that page, its label, working and any drawing included, and nothing of other parts.
- "answer": for a part marked (short), the student's final answer exactly as written; for other parts leave it out.
Reply with JSON only: {"parts": [{"part": "1a", "pages": [1], "boxes": [{"page": 1, "box": [60, 50, 950, 180]}], "answer": "..."}]}"""

# Short parts: one word or number read off the page, marked in code.
SHORT = {"1b", "3b", "8b", "11", "12"}
WRITTEN = {"1b": "nucleus", "3b": "(x - 3)(x - 3)", "8b": "4", "11": "red blood cells fight infection", "12": ""}

# Where each part's lines sit: page -> [(part, first line, last line)], line
# indexes into PAGES[page - 1] (paper_fixture.render's layout). Q7 is the graph.
LINES = {
    1: [("1a", 2, 5), ("1b", 7, 7)],
    2: [("2", 0, 2), ("3a", 4, 6)],
    3: [("3b", 0, 0), ("4a", 2, 4)],
    4: [("4b", 0, 0), ("5", 2, 5)],
    5: [("6", 0, 4)],
    6: [("6", 0, 2)],
    7: [("7", 0, 1)],
    8: [("8a", 0, 1), ("8b", 3, 3), ("9", 5, 5), ("11", 7, 7)],
    9: [("10", 0, 2)],
    10: [("12", 0, 0)],
}
W, H = 2480, 3508
PAD = (0, 20, 40)


def line_tops(page: list[str]) -> list[int]:
    tops, y = [], 205
    for line in page:
        tops.append(y)
        if line != "GRAPH":
            y += 110 if line else 90
    return tops


def true_boxes():
    """part -> {page: box in thousandths}, from the render's own coordinates."""
    out: dict[str, dict[int, list[float]]] = {}
    for n, spans in LINES.items():
        tops = line_tops(PAGES[n - 1])
        for part, first, last in spans:
            if PAGES[n - 1][first] == "7" and n == 7:  # the graph: its drawn extent
                box = [120, 205, 1720, 2420]
            else:
                text = max(len(PAGES[n - 1][i]) for i in range(first, last + 1))
                box = [150, tops[first] - 10, min(W - 100, 170 + text * 44), tops[last] + 105]
            out.setdefault(part, {})[n] = [box[0] / W * 1000, box[1] / H * 1000, box[2] / W * 1000, box[3] / H * 1000]
    return out


def area(b):
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def overlap(a, b):
    return area([max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])])


def score(got: dict, truth) -> dict:
    rows = {}
    for part, _, _, _ in PARTS:
        entry = got.get(part) or {}
        want = truth.get(part, {})
        boxes = {b.get("page"): b.get("box") for b in entry.get("boxes") or [] if isinstance(b, dict)}
        cover, ious = {pad: [] for pad in PAD}, []
        for page, tb in want.items():
            pb = boxes.get(page)
            if not (isinstance(pb, list) and len(pb) == 4):
                for pad in PAD:
                    cover[pad].append(0.0)
                ious.append(0.0)
                continue
            for pad in PAD:
                padded = [max(0, pb[0] - pad), max(0, pb[1] - pad), min(1000, pb[2] + pad), min(1000, pb[3] + pad)]
                cover[pad].append(overlap(padded, tb) / area(tb))
            inter = overlap(pb, tb)
            ious.append(inter / (area(pb) + area(tb) - inter))
        row = {
            "pages_ok": sorted(entry.get("pages") or []) == sorted(want),
            "boxes": entry.get("boxes"),
            "cover": round(min(cover[0]), 2) if want else None,
            "iou": round(min(ious), 2) if ious else None,
            **{f"cover_pad{pad}": round(min(cover[pad]), 2) for pad in PAD[1:] if want},
        }
        if part in SHORT:
            row["answer"] = entry.get("answer")
            row["answer_ok"] = (entry.get("answer") or "").replace(" ", "").lower() == WRITTEN[part].replace(" ", "").lower()
        rows[part] = row
    return rows


async def one(client, edge: int):
    labels = "\n".join(f"{p}: {q}{' (short)' if p in SHORT else ''}" for p, q, _, _ in PARTS)
    content = [{"type": "text", "text": f"Question parts:\n{labels}\n\nPages:"}, *pages_content(range(1, len(PAGES) + 1), edge)]
    t = time.time()
    text, usage = await call(client, "transcribe", [{"role": "system", "content": TRANSCRIBE}, {"role": "user", "content": content}], thinking=False, max_tokens=6000)
    got = {e["part"]: e for e in json.loads(text)["parts"]}
    rows = score(got, true_boxes())
    boxed = [r for p, r in rows.items() if r["cover"] is not None]
    return {
        "method": f"transcribe @{edge}", "wall_s": round(time.time() - t, 1), "usage": total([usage]),
        "pages_ok": f"{sum(r['pages_ok'] for r in rows.values())}/{len(rows)}",
        "answers_ok": f"{sum(r.get('answer_ok', False) for r in rows.values())}/{len(SHORT)}",
        "cover_90": f"{sum(r['cover'] >= 0.9 for r in boxed)}/{len(boxed)}",
        **{f"cover_90_pad{pad}": f"{sum(r[f'cover_pad{pad}'] >= 0.9 for r in boxed)}/{len(boxed)}" for pad in PAD[1:]},
        **{f"cover_98_pad{pad}": f"{sum(r[f'cover_pad{pad}'] >= 0.98 for r in boxed)}/{len(boxed)}" for pad in PAD[1:]},
        "mean_iou": round(sum(r["iou"] for r in boxed) / len(boxed), 2),
        "parts": rows,
    }


async def main():
    rows = []
    async with httpx.AsyncClient(timeout=600) as client:
        for _ in range(RUNS):
            for edge in (1024, 1568):
                try:
                    row = await one(client, edge)
                except Exception as exc:
                    row = {"error": repr(exc)[:300]}
                print(json.dumps({k: v for k, v in row.items() if k != "parts"}))
                rows.append(row)
    OUT.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
