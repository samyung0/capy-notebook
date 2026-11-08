"""The approved upload prompts, word for word, before they are built: R reads a
paper's pages and closed answers, P1 + B grade open parts four to a call.

    uv run --with httpx --with pillow python -I paper_prompts.py <repo> <env file> <pages dir> <out.jsonl> [runs]

1. R on a 3-page paper of every closed type (choice with a crossed-out mark,
   choose-two, true/false, gaps with one left empty, matching, ordering, short),
   an open part answered out of order and an unanswered part.
2. R on the 10-page paper (paper_fixture.py, rendered into <pages dir>), then
   its open parts graded with SYSTEM_PROMPT + DRAWN_SECTION + P1 + B, four parts
   a call, each batch with the union of R's pages at 1,568 px.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from paper_fixture import FONT, PAGES, PARTS, render  # noqa: E402
from paper_marking import DRAWN, OUT, PAGES_DIR, RUNS, SYSTEM, call, items_text, marks_from, pages_content, total  # noqa: E402

R = """You see every page of one student's answer paper, in order, then the list of question parts. For each part give:
- "pages": the pages where the student answers it, in order. Answers may run over several pages or come out of order; a part the student did not answer gets [].
- "answer": the student's final answer, in the shape its type asks for below. Leave it out for open and drawing parts, and when the part is unanswered or you cannot read it.
  - choice: the letters the student marked, such as ["B"] or ["A", "D"]. A crossed-out or erased mark does not count.
  - true/false: true or false.
  - short: the final answer as written.
  - gaps: one entry per numbered gap, in order; "" for a gap left empty.
  - matching: each numbered item's letter, such as {"1": "C", "2": "A"}.
  - ordering: the item letters in the order the student puts them.
Copy what the student wrote; never correct it. Reply with JSON only, such as {"parts": [{"part": "1a", "pages": [1], "answer": ["B"]}]}."""

P1 = """

Page answers: when the student's answer comes as page images instead of <student_answer> text, the pages are the student's written work and everything above applies to them.
- The pages may hold answers to other questions or parts; mark only the answer to the part in <question>.
- Read handwriting as written; anything you cannot read earns nothing.
- "quote" copies, in at most 12 words, the words or working on the page that earn the credit."""

B = """

Several parts: this time you mark every part listed in <parts> at once. Everything above applies to each part on its own.
- Find each part's answer anywhere in the pages given; it may run over several pages or come out of order. A part with no answer earns "none" on every item.
- Mark only what the student wrote for that part.
Reply with JSON only, one entry per part in the given order: {"parts": [{"part": "1a", "steps": [], "vocabulary_only": false, "injection_suspected": false, "comment": "", "items": [{"id": "m0", "quote": "", "reason": "", "choice": "full"}]}]}"""


def lettered(options):
    return "\n".join(f"{chr(65 + i)}. {o}" for i, o in enumerate(options))


# Closed paper: (part, type, question as the read call lists it, expected pages, expected answer)
CLOSED = [
    ("1", "choice", "Where does aerobic respiration take place?\n" + lettered(["nucleus", "mitochondrion", "ribosome", "chloroplast"]), [1], ["B"]),
    ("2", "choice", "Choose TWO renewable energy sources.\n" + lettered(["coal", "wind", "natural gas", "solar", "oil"]), [1], ["B", "D"]),
    ("3", "true/false", "Sound travels faster in air than in water.", [1], False),
    ("4", "gaps", "Water boils at [1] °C at sea level and freezes at [2] °C.", [1], ["100", "0"]),
    ("5", "matching", "Match each organ to its job.\nItems:\n1. heart\n2. lungs\n3. kidney\nOptions:\n" + lettered(["filters the blood", "pumps blood", "gas exchange"]), [2], {"1": "B", "2": "C", "3": "A"}),
    ("6", "ordering", "Put the stages of mitosis in order.\n" + lettered(["prophase", "anaphase", "metaphase", "telophase"]), [2], ["A", "C", "B", "D"]),
    ("7", "short", "Name the gas plants take in for photosynthesis.", [2], "carbon dioxide"),
    ("8", "open", "Explain why a cut apple turns brown faster when it is warm.", [3], None),
    ("9", "gaps", "The [1] carries blood away from the heart and the [2] carries it back.", [3], ["artery", ""]),
    ("10", "choice", "Which particle has a negative charge?\n" + lettered(["proton", "neutron", "electron"]), [], None),
]

# What the student wrote; ("STRIKE", text) draws text with a line through it.
CLOSED_PAGES = [
    ["Name: Cara Moss     Science quiz", "", ["1  ", ("STRIKE", "A"), "  B"], "", "2  B and D", "", "3  False", "", "4  (1) 100     (2) 0"],
    ["5  1 - B", "   2 - C", "   3 - A", "", "6  A, C, B, D", "", "7  carbon dioxide"],
    ["9  (1) artery     (2) ", "", "8  Enzymes work faster when warm, so the", "   browning reaction is quicker. Cold slows", "   the enzymes down."],
]


def render_closed(page, long_edge: int) -> Image.Image:
    w, h = 2480, 3508
    img = Image.new("RGB", (w, h), (246, 244, 238))
    d = ImageDraw.Draw(img)
    for y in range(300, h - 150, 110):
        d.line([(120, y), (w - 120, y)], fill=(185, 200, 225), width=3)
    font, ink, y = ImageFont.truetype(FONT, 84), (30, 40, 90), 205
    for line in page:
        x = 170
        for piece in line if isinstance(line, list) else [line]:
            text = piece[1] if isinstance(piece, tuple) else piece
            d.text((x, y), text, font=font, fill=ink)
            width = d.textlength(text, font=font)
            if isinstance(piece, tuple):
                d.line([(x - 15, y + 70), (x + width + 15, y + 30)], fill=ink, width=8)
            x += width
        y += 110 if line else 90
    img = img.rotate(0.6, fillcolor=(230, 228, 222), resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.6))
    scale = long_edge / max(img.size)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


def norm(v):
    if isinstance(v, str):
        return v.replace(" ", "").lower()
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        return {k: norm(x) for k, x in v.items()}
    return v


async def read(client, labels: str, pages: list[str]):
    content = [{"type": "text", "text": f"Question parts:\n{labels}\n\nPages:"}]
    for n, name in enumerate(pages, 1):
        content += [{"type": "text", "text": f"Page {n}:"}, image(name)]
    text, usage = await call(client, "read", [{"role": "system", "content": R}, {"role": "user", "content": content}], thinking=False, max_tokens=6000)
    return {e["part"]: e for e in json.loads(text)["parts"]}, usage


def image(name: str) -> dict:
    from paper_marking import image as load

    return load(name)


async def closed_read(client):
    names = []
    for n, page in enumerate(CLOSED_PAGES, 1):
        name = f"closed_p{n}_1024.jpg"
        render_closed(page, 1024).save(PAGES_DIR / name, "JPEG", quality=75)
        names.append(name)
    labels = "\n\n".join(f"{p} ({t}): {q}" for p, t, q, _, _ in CLOSED)
    t = time.time()
    got, usage = await read(client, labels, names)
    rows = {}
    for p, kind, _, pages, answer in CLOSED:
        e = got.get(p) or {}
        rows[p] = {"type": kind, "pages_ok": (e.get("pages") or []) == pages, "answer": e.get("answer"),
                   "answer_ok": answer is None and e.get("answer") in (None, "", []) or norm(e.get("answer")) == norm(answer)}
    return {"method": "R closed types @1024", "wall_s": round(time.time() - t, 1), "usage": total([usage]),
            "pages_ok": f"{sum(r['pages_ok'] for r in rows.values())}/{len(rows)}",
            "answers_ok": f"{sum(r['answer_ok'] for r in rows.values())}/{len(rows)}", "parts": rows}


SHORT = {"1b", "3b", "8b", "11", "12"}
TRUE_PAGES = {"1a": [1], "1b": [1], "2": [2], "3a": [2], "3b": [3], "4a": [3], "4b": [4], "5": [4], "6": [5, 6], "7": [7], "8a": [8], "8b": [8], "9": [8], "10": [9], "11": [8], "12": []}


async def paper(client):
    labels = "\n".join(f"{p} ({'short' if p in SHORT else 'open'}): {q}" for p, q, _, _ in PARTS)
    t = time.time()
    got, read_usage = await read(client, labels, [f"p{n:02d}_1024.jpg" for n in range(1, len(PAGES) + 1)])
    pages = {p: [n for n in (got.get(p) or {}).get("pages") or [] if isinstance(n, int)] for p, _, _, _ in PARTS}
    open_parts = [(p, q, i, e) for p, q, i, e in PARTS if p not in SHORT and pages[p]]
    batches = [open_parts[k:k + 4] for k in range(0, len(open_parts), 4)]
    usages, marks, misses = [read_usage], {}, {}

    async def one(batch):
        union = sorted({n for p, *_ in batch for n in pages[p]})
        parts = "\n\n".join(f"<part id=\"{p}\">\n<question>\n{q}\n</question>\n<marking_items>\n{items_text(i)}\n</marking_items>\n</part>" for p, q, i, _ in batch)
        user = [{"type": "text", "text": f"<parts>\n{parts}\n</parts>\n\nStudent's pages:"}, *pages_content(union, 1568)]
        reply, usage = await call(client, "batch", [{"role": "system", "content": SYSTEM + DRAWN + P1 + B}, {"role": "user", "content": user}], thinking=True, max_tokens=32000)
        usages.append(usage)
        try:
            entries = {e["part"]: e for e in json.loads(reply)["parts"]}
            for p, _, items, expected in batch:
                marks[p] = marks_from(items, entries[p]["items"])
                if marks[p] != expected:
                    misses[p] = entries[p]
        except Exception as exc:
            for p, *_ in batch:
                marks[p] = repr(exc)[:200]

    await asyncio.gather(*(one(b) for b in batches))
    right = [p for p, _, _, e in PARTS if p not in SHORT and marks.get(p, 0.0 if not pages[p] else None) == e]
    return {"method": "R pages + P1/B batches of 4", "wall_s": round(time.time() - t, 1), "calls": len(usages), "usage": total(usages),
            "pages_ok": f"{sum(pages[p] == TRUE_PAGES[p] for p in pages)}/{len(pages)}",
            "open_right": f"{len(right)}/{len(PARTS) - len(SHORT)}", "marks": marks, "pages": pages, "misses": misses}


async def main():
    for n, page in enumerate(PAGES, 1):
        for edge in (1024, 1568):
            target = PAGES_DIR / f"p{n:02d}_{edge}.jpg"
            if not target.exists():
                render(page, edge).save(target, "JPEG", quality=75)
    rows = []
    async with httpx.AsyncClient(timeout=600) as client:
        for _ in range(RUNS):
            for job in (closed_read(client), paper(client)):
                try:
                    row = await job
                except Exception as exc:
                    row = {"error": repr(exc)[:300]}
                print(json.dumps({k: v for k, v in row.items() if k not in ("parts", "pages", "marks")}))
                rows.append(row)
    OUT.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
