"""Fewer calls for an uploaded paper: closed parts read in one call, open parts
graded in batches.

    uv run --with httpx --with pillow python -I paper_batching.py <repo> <env file> <pages dir> <out.jsonl> [runs]

1. MC read: a 120-question bubble answer sheet (2 pages of 60, or 1 page of
   120) read in one call; code compares each letter with the truth, as it would
   with the key. Erased marks, double marks and blanks are planted.
2. Open parts in batches: the 10-page paper (paper_fixture.py, already rendered
   in <pages dir>) mapped once, then graded a batch of parts per call, against
   G2's one call a part (paper_marking.py).
"""

from __future__ import annotations

import asyncio
import json
import random
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
from paper_fixture import FONT, PAGES, PARTS  # noqa: E402
from paper_marking import (  # noqa: E402
    DRAWN, MAP, OUT, PAGE_SECTION, PAGES_DIR, RUNS, SYSTEM, WHOLE,
    call, items_text, marks_from, pages_content, score, total,
)

LETTERS = "ABCD"
MC_READ = """You see a student's multiple-choice answer sheet. For each question number from 1 to {n}, give the option the student marked: one letter from A to D. Give null when no option is marked, when two or more options are marked, or when you cannot tell. A faint or erased mark beside a dark one does not count. Reply with JSON only, such as {{"1": "B", "2": null}}."""


def mc_truth(n: int, seed: int = 11):
    """The chosen letter per question; erased (a faint second mark), double and blank planted."""
    rnd = random.Random(seed)
    rows = []
    for q in range(1, n + 1):
        letter = rnd.choice(LETTERS)
        kind = "plain"
        if q % 23 == 0:
            kind = "blank"
        elif q % 17 == 0:
            kind = "double"
        elif q % 13 == 0:
            kind = "erased"
        rows.append((q, letter, kind))
    return rows


def render_sheet(rows, cols: int, per_col: int, long_edge: int, title: str) -> Image.Image:
    w, h = 2480, 3508
    img = Image.new("RGB", (w, h), (250, 250, 248))
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 44)
    hand = ImageFont.truetype(FONT, 70)
    d.text((160, 120), title, font=font, fill=(40, 40, 40))
    d.text((1500, 105), "Name: Cara Moss", font=hand, fill=(30, 40, 90))
    top, row_h = 330, (h - 450) / per_col
    col_w = (w - 300) / cols
    r = int(min(row_h * 0.36, 34))
    rnd = random.Random(5)
    for i, (q, letter, kind) in enumerate(rows):
        c, k = divmod(i, per_col)
        x0, y = 150 + c * col_w, top + k * row_h
        d.text((x0, y - 22), f"{q:>3}", font=font, fill=(40, 40, 40))
        for j, opt in enumerate(LETTERS):
            cx, cy = x0 + 150 + j * (r * 3.2), y
            d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(150, 60, 60), width=3)
            d.text((cx - 11, cy - 17), opt, font=ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 26), fill=(170, 90, 90))
        def fill(opt, shade):
            j = LETTERS.index(opt)
            cx, cy = x0 + 150 + j * (r * 3.2) + rnd.uniform(-3, 3), y + rnd.uniform(-3, 3)
            rr = r - 4
            d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(shade, shade, shade + 6))
        other = LETTERS[(LETTERS.index(letter) + 1 + rnd.randrange(3)) % 4]
        if kind == "plain":
            fill(letter, 45)
        elif kind == "erased":
            fill(other, 205)  # rubbed out: faint grey
            fill(letter, 45)
        elif kind == "double":
            fill(letter, 45)
            fill(other, 50)
    img = img.rotate(0.5, fillcolor=(235, 235, 232), resample=Image.BICUBIC).filter(ImageFilter.GaussianBlur(0.5))
    scale = long_edge / max(img.size)
    return img.resize((round(img.width * scale), round(img.height * scale)), Image.LANCZOS)


async def mc_read(client, layout: str, edge: int):
    rows = mc_truth(120)
    if layout == "2x60":
        pages = [render_sheet(rows[:60], 2, 30, edge, "Answer sheet, page 1 of 2"), render_sheet(rows[60:], 2, 30, edge, "Answer sheet, page 2 of 2")]
    else:
        pages = [render_sheet(rows, 3, 40, edge, "Answer sheet")]
    names = []
    for i, page in enumerate(pages, 1):
        name = f"mc_{layout}_{edge}_{i}.jpg"
        page.save(PAGES_DIR / name, "JPEG", quality=80)
        names.append(name)
    from paper_marking import image  # local: reads PAGES_DIR

    content = [{"type": "text", "text": "Pages:"}]
    for i, name in enumerate(names, 1):
        content += [{"type": "text", "text": f"Page {i}:"}, image(name)]
    t = time.time()
    text, usage = await call(client, "mc", [{"role": "system", "content": MC_READ.format(n=len(rows))}, {"role": "user", "content": content}], thinking=False, max_tokens=4000)
    got = json.loads(text)
    wrong = []
    for q, letter, kind in rows:
        want = None if kind in ("blank", "double") else letter
        if got.get(str(q)) != want:
            wrong.append({"q": q, "kind": kind, "want": want, "got": got.get(str(q))})
    return {"method": f"MC read 120, {layout} @{edge}", "wall_s": round(time.time() - t, 1), "usage": total([usage]), "right": f"{len(rows) - len(wrong)}/{len(rows)}", "wrong": wrong}


async def batched(client, batch_size: int):
    t = time.time()
    labels = "\n".join(f"{p}: {q}" for p, q, _, _ in PARTS)
    text, map_usage = await call(client, "map", [{"role": "system", "content": MAP}, {"role": "user", "content": [{"type": "text", "text": f"Question parts:\n{labels}\n\nPages:"}, *pages_content(range(1, len(PAGES) + 1), 1024)]}], thinking=False, max_tokens=2000)
    mapping = json.loads(text)
    found = [(p, q, i) for p, q, i, _ in PARTS if mapping.get(p)]
    got = {p: {"marks": 0.0, "pages": [], "skipped": True} for p, _, _, _ in PARTS if not mapping.get(p)}
    batches = [found[k:k + batch_size] for k in range(0, len(found), batch_size)]
    usages = [map_usage]

    async def one(batch):
        pages = sorted({n for p, _, _ in batch for n in mapping[p]})
        parts = "\n\n".join(f"<part id=\"{p}\">\n<question>\n{q}\n</question>\n<marking_items>\n{items_text(i)}\n</marking_items>\n</part>" for p, q, i in batch)
        user = [{"type": "text", "text": f"<parts>\n{parts}\n</parts>\n\nStudent's pages:"}, *pages_content(pages, 1568)]
        reply, usage = await call(client, "batch", [{"role": "system", "content": SYSTEM + DRAWN + PAGE_SECTION + WHOLE}, {"role": "user", "content": user}], thinking=True, max_tokens=32000)
        usages.append(usage)
        try:
            entries = {e["part"]: e for e in json.loads(reply)["parts"]}
            for p, _, items in batch:
                got[p] = {"marks": marks_from(items, entries[p]["items"]), "pages": pages}
        except Exception as exc:
            for p, _, _ in batch:
                got[p] = {"error": repr(exc)[:200]}

    await asyncio.gather(*(one(b) for b in batches))
    return {"method": f"Map + batches of {batch_size}", "wall_s": round(time.time() - t, 1), "calls": len(usages), "usage": total(usages), "parts": got}


async def main():
    rows = []
    async with httpx.AsyncClient(timeout=600) as client:
        for _ in range(RUNS):
            jobs = [mc_read(client, "2x60", 1568), mc_read(client, "1x120", 1568), batched(client, 4), batched(client, 8)]
            for job in jobs:
                try:
                    row = await job
                    if "parts" in row:
                        row = score(row)
                except Exception as exc:
                    row = {"error": repr(exc)[:300]}
                print(json.dumps({k: v for k, v in row.items() if k != "parts"}))
                rows.append(row)
    OUT.write_text("\n".join(json.dumps(r) for r in rows) + "\n")


if __name__ == "__main__":
    asyncio.run(main())
